/**
 * Welcome-1b — the idempotent in-process starter-content seeder.
 *
 * Creates the bundled starter set (`buildWelcomeStarterSet`) through the
 * entities service and plants the note bodies into their universal-body
 * Y.Docs, gated on a per-vault `welcome:seedVersion` stamp so it runs exactly
 * once. Pure orchestration over injected dependencies — the real binding
 * (entities repo + DEK mint, the ydoc worker plant, the on-disk stamp store)
 * lives in the vault-init wiring; this keeps the seed logic (idempotency,
 * create-all, plant-all, per-entity error isolation) fully testable in-process
 * without a live vault session.
 *
 * The seed is privileged: the shell vouches for its own content (a sentinel
 * `created_by`, no capability prompt), per the OQ-WC-1 resolution (seed lands
 * inside vault initialization, before the dashboard mounts).
 *
 * One-shot semantics: the stamp is written after the run completes (even on a
 * partial per-entity failure) so the seeder never re-creates entities it
 * already minted (`repo.create` on a duplicate stable id would throw). A
 * starter-content failure is cosmetic, never data-critical — failures are
 * collected and logged, not propagated.
 */

import {
	WELCOME_SEED_CREATED_BY,
	WELCOME_SEED_VERSION,
	type WelcomeBody,
	type WelcomeSeedLink,
	buildWelcomeStarterLinks,
	buildWelcomeStarterSet,
} from "./welcome-content";

export enum WelcomeSeedOutcome {
	/** The starter set was planted this run. */
	Seeded = "seeded",
	/** The vault's stamp already covers the bundled version; nothing done. */
	AlreadySeeded = "already-seeded",
}

export type WelcomeSeedResult = {
	readonly outcome: WelcomeSeedOutcome;
	readonly created: number;
	readonly planted: number;
	readonly errors: ReadonlyArray<string>;
};

export type WelcomeSeedEntitySpec = {
	readonly id: string;
	readonly type: string;
	readonly properties: Record<string, unknown>;
	readonly createdBy: string;
	readonly now: number;
};

export type WelcomeSeedDeps = {
	/** Create one entity directly through the in-process entities repo
	 *  (privileged — bypasses the broker; the shell vouches for its seed). */
	readonly createEntity: (spec: WelcomeSeedEntitySpec) => void | Promise<void>;
	/** Plant a serialized body into the entity's universal-body Y.Doc. */
	readonly plantBody: (entityId: string, body: WelcomeBody) => void | Promise<void>;
	/** Materialise a note→entity mention link. Optional so in-process tests that
	 *  only exercise entity/body seeding can omit it; production always wires it
	 *  (`makeSeedEntityDeps`) so Graph/backlinks are populated on first open. */
	readonly createLink?: (link: WelcomeSeedLink) => void | Promise<void>;
	/** The vault's last-seeded version (`0` when never seeded). */
	readonly readVersion: () => number | Promise<number>;
	/** Persist the seeded version. */
	readonly writeVersion: (version: number) => void | Promise<void>;
	/** Epoch-ms stamped onto every seeded entity (no `Date.now()` inside). */
	readonly now: number;
};

export async function seedWelcomeContent(deps: WelcomeSeedDeps): Promise<WelcomeSeedResult> {
	const current = await deps.readVersion();
	if (current >= WELCOME_SEED_VERSION) {
		return { outcome: WelcomeSeedOutcome.AlreadySeeded, created: 0, planted: 0, errors: [] };
	}

	const set = buildWelcomeStarterSet(deps.now);
	const errors: string[] = [];
	let created = 0;
	let planted = 0;

	for (const entity of set) {
		try {
			await deps.createEntity({
				id: entity.id,
				type: entity.type,
				properties: entity.properties,
				createdBy: WELCOME_SEED_CREATED_BY,
				now: deps.now,
			});
			created += 1;
			if (entity.body) {
				await deps.plantBody(entity.id, entity.body);
				planted += 1;
			}
		} catch (error) {
			errors.push(`${entity.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// Second pass: materialise the hub note's `@`-mention links now that every
	// dest entity exists (a link's endpoints must both be present). Isolated,
	// idempotent (`putLink` upserts by a deterministic id), and cosmetic — a
	// failure is collected, never propagated, same posture as entity seeding.
	if (deps.createLink) {
		for (const link of buildWelcomeStarterLinks(deps.now)) {
			try {
				await deps.createLink(link);
			} catch (error) {
				errors.push(`link ${link.id}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	// Stamp after the run (even on partial failure) so we never re-mint a
	// stable id that already exists. A stamp-write failure leaves the next
	// launch to retry — create-on-existing-id throws and is isolated above.
	try {
		await deps.writeVersion(WELCOME_SEED_VERSION);
	} catch (error) {
		errors.push(`stamp: ${error instanceof Error ? error.message : String(error)}`);
	}

	return { outcome: WelcomeSeedOutcome.Seeded, created, planted, errors };
}
