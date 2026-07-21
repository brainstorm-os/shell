/**
 * The `platform` broker service (doc 63 — the Agent context layer). The
 * app-facing, read-only window onto the installed-app registry: a sanitized
 * snapshot of the apps, the object types they produce (+ properties), and their
 * action vocabulary. The Agent reads it to learn what world it is in (its
 * `CLAUDE.md`-analog capabilities context); other apps may build discovery UIs
 * on it.
 *
 * Method:
 *   - `catalog()` → {@link PlatformCatalog}. No vault content — purely registry
 *     metadata; data stays behind `entities` / `search`.
 *
 * SECURITY: like the network / mcp handlers, the broker's generic declared-caps
 * check is necessary-but-not-sufficient (the app controls `envelope.caps`).
 * `platform.read` is scarce (not a default grant), so we RE-CHECK it against the
 * active vault's ledger here — the authoritative gate. Fail-closed throughout:
 * no vault / no grant / ledger error → a typed `Unavailable` / `Denied`, never a
 * silent snapshot.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type CapabilityLedger, LedgerUnavailableError } from "@brainstorm-os/capabilities/ledger";
import type { PlatformCatalog } from "@brainstorm-os/sdk-types";
import type { SqliteDatabase } from "@brainstorm-os/sqlite";
import type { ServiceHandler } from "../../ipc/broker";
import type { Envelope } from "../../ipc/envelope";
import { AppsRepository } from "../storage/registry-repo/apps-repo";
import { EntityTypesRepository } from "../storage/registry-repo/entity-types-repo";
import { IntentsRepository } from "../storage/registry-repo/intents-repo";
import { type AppManifestMeta, buildPlatformCatalog } from "./catalog";

/** The capability gating the catalog. Scarce — not a default grant. */
export const PLATFORM_READ_CAPABILITY = "platform.read";

export type PlatformServiceOptions = {
	/** Open the active vault's registry DB. `null` → no open vault: fail closed
	 *  (`Unavailable`). */
	readonly getRegistry: () => Promise<SqliteDatabase | null>;
	/** SECURITY — the active vault's capability ledger, used to re-check
	 *  `platform.read` server-side (never trusting `envelope.caps`). Absent → the
	 *  cap gate is skipped (unit tests that presume authorization). */
	readonly getLedger?: () => Promise<CapabilityLedger | null>;
	/** Read an app bundle's manifest display meta. Injectable for tests;
	 *  production reads `<bundleDir>/manifest.json` from disk. */
	readonly readManifestMeta?: (bundleDir: string) => AppManifestMeta;
};

function makeError(name: string, message: string): Error {
	const err = new Error(message);
	err.name = name;
	return err;
}

/** Read an app's display meta from its on-disk manifest. Mirrors
 *  apps-handlers `describeApp`: name / description / icon presence, with the
 *  manifest unreadable degrading to "no meta" (the assembler falls back to id). */
function readManifestMetaFromDisk(bundleDir: string): AppManifestMeta {
	try {
		const raw = readFileSync(join(bundleDir, "manifest.json"), "utf8");
		const manifest = JSON.parse(raw) as {
			name?: unknown;
			icon?: unknown;
			description?: unknown;
		};
		return {
			name: typeof manifest.name === "string" ? manifest.name : undefined,
			description: typeof manifest.description === "string" ? manifest.description : undefined,
			hasIcon: typeof manifest.icon === "string" && manifest.icon.length > 0,
		};
	} catch {
		return { hasIcon: false };
	}
}

/** Re-check `platform.read` against the ledger (the authoritative gate). Fails
 *  closed: ledger error / no vault → `Unavailable`; not held → `Denied`. No-op
 *  when `getLedger` is unwired. */
async function requirePlatformRead(
	envelope: Envelope,
	options: PlatformServiceOptions,
): Promise<void> {
	if (!options.getLedger) return;
	let ledger: CapabilityLedger | null;
	try {
		ledger = await options.getLedger();
	} catch (error) {
		if (error instanceof LedgerUnavailableError) {
			throw makeError("Unavailable", "platform: capability ledger unavailable");
		}
		throw error;
	}
	if (!ledger) throw makeError("Unavailable", "platform: no active vault session");
	let held: boolean;
	try {
		held = ledger.has(envelope.app, PLATFORM_READ_CAPABILITY);
	} catch (error) {
		if (error instanceof LedgerUnavailableError) {
			throw makeError("Unavailable", "platform: capability ledger unavailable");
		}
		throw error;
	}
	if (!held) {
		throw makeError("Denied", `platform.catalog: ${envelope.app} lacks ${PLATFORM_READ_CAPABILITY}`);
	}
}

async function handleCatalog(
	envelope: Envelope,
	options: PlatformServiceOptions,
): Promise<PlatformCatalog> {
	await requirePlatformRead(envelope, options);
	const registry = await options.getRegistry();
	if (!registry) throw makeError("Unavailable", "platform: no active vault session");

	const appsRepo = new AppsRepository(registry);
	const entityTypesRepo = new EntityTypesRepository(registry);
	const intentsRepo = new IntentsRepository(registry);
	const readMeta = options.readManifestMeta ?? readManifestMetaFromDisk;

	const apps = appsRepo.listActive();
	const bundleDirById = new Map(apps.map((a) => [a.id, a.bundleDir] as const));

	return buildPlatformCatalog({
		apps: apps.map((a) => ({ id: a.id })),
		readManifestMeta: (appId) => {
			const bundleDir = bundleDirById.get(appId);
			return bundleDir ? readMeta(bundleDir) : null;
		},
		// Orphaned types (introducer uninstalled) are excluded — the agent reasons
		// only about types a live app actually produces.
		entityTypes: entityTypesRepo.listAll().filter((t) => !t.orphaned),
		intents: intentsRepo.listAll(),
	});
}

export function makePlatformServiceHandler(options: PlatformServiceOptions): ServiceHandler {
	return async (envelope: Envelope): Promise<unknown> => {
		switch (envelope.method) {
			case "catalog":
				return await handleCatalog(envelope, options);
			default:
				throw makeError("Invalid", `unknown platform method: ${envelope.method}`);
		}
	};
}
