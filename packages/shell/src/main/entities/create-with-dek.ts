/**
 * The one place an entity row is born WITH its per-entity DEK and its
 * per-device member wrap (Stage 10.1 + 10.3a).
 *
 * Two privileged paths create entities on a caller's behalf: the entities
 * service (`entities.create`, an app's own write) and the channel-proposal
 * approve path (Agent-Teams-3, a human's approval of an agent's draft). Both
 * need the identical, subtle sequence — forward-allocate the `dekId` so the
 * row's very first INSERT carries it, write the row and the sealed DEK inside
 * ONE transaction (the FK on `entity_deks.entity_id` requires the parent
 * first), install the member wrap on the Y.Doc while the plaintext DEK is
 * still live, and zero that DEK whatever happens.
 *
 * It lived only in the entities service, so the approve path passed
 * `dekId: null` and produced a second-class row: no DEK, no wrap, un-shareable
 * until the next vault open's retro-wrap pass. Duplicating the sequence there
 * would have been a second implementation of a security-critical ordering, so
 * it is extracted here instead and both callers route through it.
 *
 * WHAT A CALLER STILL OWNS: capability checks, the shell-owned-type fence,
 * property construction, Y.Doc seeding, change events. This helper is the
 * key-management seam only.
 */

import type { EntitiesRepository, EntityRow } from "../storage/entities-repo";
import type { EntityDekHandle, EntityDekStore } from "./entity-dek-store";

/** What to do with a freshly-created row when its member-wrap install fails.
 *
 *  The wrap round-trips to the ydoc worker, so it necessarily happens AFTER
 *  the SQLite transaction commits — the two policies are the two honest answers
 *  to "the row is committed but un-wrapped". */
export enum DekWrapFailurePolicy {
	/** Un-create the row (soft- then hard-delete). For a create nobody has seen
	 *  yet: the caller is about to throw, so no user-visible object vanishes and
	 *  a half-created row cannot strand. */
	RollbackRow = "rollback-row",
	/** Keep the row and surface the failure to the caller's logger. For a row
	 *  the user has already been told exists (an approved proposal): deleting it
	 *  would be a worse lie than a missing wrap. The row still carries a real
	 *  DEK, so the sync wire path never sees an ambiguous null-DEK row — the
	 *  same posture `retro-wrap-deks.ts` takes for the identical case. */
	KeepRow = "keep-row",
}

export type CreateWithDekDeps = {
	readonly repo: EntitiesRepository;
	readonly dekStore: EntityDekStore;
	/** Stage 10.3a — install the `MemberWrapPayload` addressed to this device on
	 *  the new entity's Y.Doc. Absent in legacy/test contexts. */
	readonly installEntityWrap?: (entityId: string, dek: Uint8Array, type?: string) => Promise<void>;
};

export type CreateWithDekInput = {
	readonly id: string;
	readonly type: string;
	readonly properties: Record<string, unknown>;
	readonly createdBy: string;
	readonly now: number;
};

export type CreateWithDekHooks = {
	/** Runs FIRST inside the transaction. Returning false aborts the whole
	 *  create (nothing is written) — the seam the approve path's "is this
	 *  proposal still Pending?" re-check needs to be atomic with the create. */
	readonly guard?: () => boolean;
	/** Runs after the row + DEK land, still inside the same transaction — for
	 *  writes that must commit atomically with the create (settling the
	 *  proposal card that authorised it). */
	readonly alsoWrite?: (created: EntityRow) => void;
	/** Called (never thrown through) when {@link DekWrapFailurePolicy.KeepRow}
	 *  swallows a wrap-install failure. */
	readonly onWrapFailed?: (error: Error) => void;
};

export type CreateWithDekResult =
	| { readonly ok: true; readonly row: EntityRow }
	/** The guard refused — nothing was written. */
	| { readonly ok: false };

/**
 * Create `input` as a row carrying a freshly-minted, master-key-sealed DEK,
 * then install this device's member wrap on its Y.Doc.
 *
 * The plaintext DEK is zeroed in a `finally`, whether the transaction commits,
 * the guard aborts, or the wrap install throws.
 */
export async function createEntityWithDek(
	deps: CreateWithDekDeps,
	input: CreateWithDekInput,
	policy: DekWrapFailurePolicy,
	hooks: CreateWithDekHooks = {},
): Promise<CreateWithDekResult> {
	const { repo, dekStore } = deps;
	// Forward-allocated (pure id generation, no I/O) so the row's first INSERT
	// stamps `dek_id` — no follow-up UPDATE, no window where the row exists
	// without naming its key.
	const dekId = dekStore.nextDekId();
	let handle: EntityDekHandle | null = null;
	try {
		const row = repo.transaction((): EntityRow | null => {
			if (hooks.guard && !hooks.guard()) return null;
			const created = repo.create({
				id: input.id,
				type: input.type,
				properties: input.properties,
				createdBy: input.createdBy,
				now: input.now,
				dekId,
			});
			// Order matters: `entity_deks.entity_id` is an FK to `entities(id)`,
			// so the parent must exist first. Either write throwing rolls both
			// back, so a failed wrap never leaves a dangling `dek_id`.
			handle = dekStore.persist(input.id, dekId);
			hooks.alsoWrite?.(created);
			return created;
		});
		if (!row) return { ok: false };

		if (deps.installEntityWrap && handle) {
			try {
				await deps.installEntityWrap(input.id, (handle as EntityDekHandle).dek, input.type);
			} catch (error) {
				if (policy === DekWrapFailurePolicy.RollbackRow) {
					try {
						repo.softDelete(input.id, input.now);
						repo.hardDelete(input.id);
					} catch {
						// Best-effort: a rollback failure is not what the caller
						// needs to see — the original wrap error is.
					}
					throw error;
				}
				hooks.onWrapFailed?.(error as Error);
			}
		}
		return { ok: true, row };
	} finally {
		if (handle) dekStore.close((handle as EntityDekHandle).dek);
	}
}
