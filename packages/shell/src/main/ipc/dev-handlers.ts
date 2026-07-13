/**
 * Dev-only IPC handlers. Registered ONLY in dev mode (`!app.isPackaged`)
 * from `main/index.ts`. Production builds never expose these channels.
 *
 * Channels:
 *   - `dev:seed-demo-apps` — installs the first-party reference apps into
 *     the active vault and pins each app's icon onto the dashboard.
 *   - `dev:refresh-app-registrations` — (7.6) re-applies an installed
 *     app's manifest registrations without an uninstall/reinstall or a
 *     shell restart, so a manifest `registrations` edit is picked up by
 *     the running IntentsBus on the next dispatch.
 *   - `dev:reseed-vault` — spawns the BrainstormProject seed-cli
 *     (`tools/mcp-server/src/seed/seed-cli.ts`) against the active vault
 *     in merge mode, then drains the seed sidecar it leaves behind. The Bun
 *     CLI can't write the encrypted `entities.db` (no SQLCipher under Bun),
 *     so it parks the projected entity snapshot in a sidecar; this handler
 *     applies it in-process (master key + SQLCipher live here) and
 *     broadcasts the vault-entities staleness signal so open apps repaint.
 */

import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ipcMain } from "electron";
import { firstPartyAppsDir } from "../apps/first-party";
import type { RefreshResult } from "../apps/installer";
import {
	type CreateAndOpenScratchNoteResult,
	createAndOpenScratchNote,
} from "../dev/notes-scratch";
import { refreshAppRegistrations } from "../dev/refresh-app-registrations";
import { reseedVaultContent } from "../dev/reseed-vault-content";
import { type SeedResult, seedDemoApps } from "../dev/seed-demo-apps";
import type { IntentsBus } from "../intents/intents-bus";
import {
	type BenchReport,
	type VecRecallReport,
	makeSqliteVecEngine,
	measureVecRecallParity,
	parseBenchOptions,
	runBench,
} from "../search/bench";
import { EntitiesRepository } from "../storage/entities-repo/entities-repo";
import { getActiveVaultSession } from "../vault/session";

export type DevHandlersOptions = {
	/** `__dirname` of the main process entry — resolves the first-party
	 *  `apps/` tree (see `firstPartyAppsDir`) and the repo root for the
	 *  seed-cli path. */
	mainDir: string;
	/** Fan out the vault-entities staleness signal to every live app
	 *  window after a reseed so open apps re-query instead of showing
	 *  the pre-seed snapshot. Injected so this module stays decoupled
	 *  from the launcher. */
	broadcastVaultEntitiesStale: () => void;
	/** Resolver for the active IntentsBus — used by
	 *  `dev:notes:create-and-open-scratch-note` to dispatch an
	 *  `intent.open` for the newly-minted note. Mirrors the lazy-getter
	 *  pattern that `intent-handlers.ts` already uses. */
	getIntents: () => IntentsBus | null | Promise<IntentsBus | null>;
};

export type DevReseedVaultResult =
	| {
			ok: true;
			backfill: {
				entitiesCreated: number;
				entitiesSkipped: number;
				entitiesHealed: number;
				entitiesResynced: number;
				entitiesRemoved: number;
				linksWritten: number;
			};
	  }
	| { ok: false; reason: string };

export type DevSearchBenchVectorResult =
	| { ok: true; report: BenchReport }
	| { ok: false; reason: string };

export type DevSearchVecRecallResult =
	| { ok: true; report: VecRecallReport }
	| { ok: false; reason: string };

export function registerDevHandlers(options: DevHandlersOptions): void {
	ipcMain.handle("dev:seed-demo-apps", async (): Promise<SeedResult> => {
		return seedDemoApps(firstPartyAppsDir(options.mainDir));
	});
	// Install the bundles already on disk without a per-app vite rebuild —
	// the dogfood harness builds apps once in its global setup, so per-session
	// re-seeding stays fast (rebuilding all 11 apps per session exceeded the
	// Playwright per-test budget and timed out at setup).
	ipcMain.handle("dev:seed-prebuilt-apps", async (): Promise<SeedResult> => {
		return seedDemoApps(firstPartyAppsDir(options.mainDir), { build: false });
	});
	ipcMain.handle(
		"dev:refresh-app-registrations",
		async (_event, appId: unknown): Promise<RefreshResult> => {
			return refreshAppRegistrations(typeof appId === "string" ? appId : "");
		},
	);
	ipcMain.handle("dev:reseed-vault", async (): Promise<DevReseedVaultResult> => {
		const session = getActiveVaultSession();
		if (!session) return { ok: false, reason: "no active vault session" };

		const repoRoot = join(options.mainDir, "..", "..", "..", "..");
		const reseeded = await reseedVaultContent(repoRoot, session);
		if (!reseeded.ok) return { ok: false, reason: reseeded.reason };

		// `reseedVaultContent` already applied the sidecar in-process (this
		// process holds the vault master key and runs the SQLCipher driver);
		// fan out the staleness signal so open apps re-query and surface the
		// fresh content without a reopen.
		const drained = reseeded.drained;
		if (drained.applied) {
			console.log(
				`[dev:reseed-vault] applied seed sidecar: ${drained.entitiesCreated} created, ` +
					`${drained.entitiesUpdated} updated, ${drained.entitiesRemoved} removed, ${drained.linksWritten} links`,
			);
		}
		options.broadcastVaultEntitiesStale();

		return {
			ok: true,
			backfill: {
				entitiesCreated: drained.entitiesCreated,
				entitiesSkipped: 0,
				entitiesHealed: 0,
				entitiesResynced: drained.entitiesUpdated,
				entitiesRemoved: drained.entitiesRemoved,
				linksWritten: drained.linksWritten,
			},
		};
	});

	// Marketing-screenshot seeder — a believable real-world studio workspace
	// (clients, projects, people, notes, tasks, events). Used by the
	// site-screenshots capture spec; never runs in production.
	ipcMain.handle("dev:seed-marketing-entities", async (): Promise<{ seeded: boolean }> => {
		const session = getActiveVaultSession();
		if (!session) return { seeded: false };
		const { seedMarketingEntities } = await import("../dev/seed-marketing-entities");
		const result = await seedMarketingEntities(session);
		options.broadcastVaultEntitiesStale();
		return result;
	});

	// 13.4a.2-followup — bench needs a contenteditable mounted before it can
	// measure key-to-paint, but `seedDemoApps` only installs the Notes app
	// (no notes inside). This shim creates a `Note/v1` row in the active
	// vault and dispatches an `intent.open` for it; the open-intent path
	// launches the Notes window with the note selected, so the bench's
	// `[contenteditable]` wait resolves immediately. Returns the new entity
	// id for log correlation.
	ipcMain.handle(
		"dev:notes:create-and-open-scratch-note",
		async (): Promise<CreateAndOpenScratchNoteResult> => {
			return createAndOpenScratchNote({
				getRepo: async () => {
					const session = getActiveVaultSession();
					if (!session) return null;
					return new EntitiesRepository(await session.dataStores.open("entities"));
				},
				getIntents: options.getIntents,
				broadcastVaultEntitiesStale: options.broadcastVaultEntitiesStale,
			});
		},
	);

	// 11.3 — real-Electron sqlite-vec ANN bench + recall parity. Runs in the
	// main process where better-sqlite3 + sqlite-vec load (unavailable under
	// Bun vitest / system Node when the native ABI mismatches Electron).
	ipcMain.handle(
		"dev:search:bench-vector",
		async (_event, rawOpts: unknown): Promise<DevSearchBenchVectorResult> => {
			const opts = parseBenchOptions(rawOpts);
			if (!opts) return { ok: false, reason: "invalid bench options" };
			const dbPath = join(tmpdir(), `bs-vec-bench-${Date.now()}.db`);
			try {
				const report = await runBench(async () => {
					const engine = await makeSqliteVecEngine(dbPath);
					if (!engine) throw new Error("sqlite-vec unavailable");
					return engine;
				}, opts);
				return { ok: true, report };
			} catch (error) {
				return { ok: false, reason: (error as Error).message ?? String(error) };
			} finally {
				try {
					unlinkSync(dbPath);
				} catch {
					/* best-effort temp cleanup */
				}
			}
		},
	);

	ipcMain.handle(
		"dev:search:vec-recall",
		async (_event, rawOpts: unknown): Promise<DevSearchVecRecallResult> => {
			const opts = parseBenchOptions(rawOpts);
			if (!opts) return { ok: false, reason: "invalid bench options" };
			const report = await measureVecRecallParity({
				seed: opts.seed,
				size: opts.size,
				k: opts.limit ?? 20,
			});
			if (!report) return { ok: false, reason: "sqlite-vec unavailable" };
			return { ok: true, report };
		},
	);
}
