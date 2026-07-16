/**
 * Dev-only seeder. Installs the bundled first-party apps from `apps/<dir>/`
 * into the active vault via `AppInstaller`, then pins each app's icon onto
 * the dashboard at the next free grid cell.
 *
 * Dev semantics: **always** uninstalls + reinstalls if an existing copy is
 * in the registry, so source edits in `apps/<dir>/` always replace the
 * vault's bundle copy on the next click. Storage data
 * (`<vault>/data/apps/<appId>/kv.json`) is untouched by uninstall, so
 * per-app state persists across reinstalls.
 *
 * Phase 3 of the apps-lifecycle plan replaces this with the real install
 * flow (file dialog + capability prompt). Until then, this exists purely
 * so the dashboard + bundled apps can be exercised end-to-end during dev.
 *
 * 13.1a refactor: the dev pipeline now factors out as
 *   `buildVitebundle` (dev-only spawn vite) →
 *   `installPrebuiltBundle` (production-shareable: install + pin) →
 *   `buildInstallPin` (dev: compose the two)
 * The production seeder (`apps/seed-packaged-apps.ts`) reuses
 * `installPrebuiltBundle` directly against a `process.resourcesPath/apps`
 * tree of prebuilt `dist/` outputs, with no vite spawn.
 *
 * The first-party list grows as Stage 9 iterations land. Files joined in
 * 9.8.1 per.
 */

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { hashBundleDirectory } from "../apps/app-bundle-hash";
import { shouldCopyBundleEntry } from "../apps/bundle-filter";
import { FIRST_PARTY_APPS, type FirstPartyApp, firstPartyAppById } from "../apps/first-party";
import { DEV_INSTALL_PROVENANCE, type InstallProvenance } from "../apps/install-provenance";
import { AppInstaller } from "../apps/installer";
import type { DashboardStore } from "../dashboard/dashboard-store";
import { pruneOrphanAppIcons } from "../dashboard/prune-orphan-app-icons";
import { getActiveShortcutRegistry } from "../shortcuts/active-registry";
import { AppsRepository } from "../storage/registry-repo/apps-repo";
import { getActiveVaultSession } from "../vault/session";

const GRID_COLS = 12;

// Re-exported so existing import sites (`./seed-demo-apps`) keep working;
// the canonical catalog now lives in `../apps/first-party`.
export { FIRST_PARTY_APPS, type FirstPartyApp } from "../apps/first-party";

export type SeedResult = {
	installed: number;
	skipped: number;
	pinned: number;
	errors: string[];
};

export async function seedDemoApps(
	appsDir: string,
	opts: { build?: boolean } = {},
): Promise<SeedResult> {
	// `build: false` installs the bundles already on disk (`<app>/dist`)
	// instead of spawning a vite build per app. The dogfood harness builds
	// the apps ONCE in its global setup, then re-seeds the persistent vault
	// every session — at ~200s for 11 source rebuilds, per-session building
	// blew the Playwright per-test budget (every session timed out during
	// setup). Prebuilt install is ~seconds. The dev/auto seeder keeps the
	// default `build: true` so a running shell always reflects edited source.
	const build = opts.build ?? true;
	const session = getActiveVaultSession();
	if (!session) {
		throw new Error("seedDemoApps: no active vault session");
	}
	const registry = await session.dataStores.open("registry");
	const ledger = await session.capabilityLedger();
	const shortcutRegistry = getActiveShortcutRegistry();
	const installer = new AppInstaller(
		session.vaultPath,
		registry,
		ledger,
		shortcutRegistry ?? undefined,
	);
	const appsRepo = new AppsRepository(registry);
	const dashboard = await session.dashboardStore();

	const result: SeedResult = { installed: 0, skipped: 0, pinned: 0, errors: [] };
	const installedIds = new Set<string>();

	// Coalesce the per-app icon writes so the dashboard paints all icons in
	// one snapshot instead of one-by-one as each bundle finishes.
	await dashboard.batch(async () => {
		for (const app of FIRST_PARTY_APPS) {
			// A bundle that *throws* (fs/SQL/ledger failure, not the {ok:false}
			// validation path) must not unwind the batch and abort the remaining
			// apps + the orphan sweep below — record it and move on, same as a
			// reported failure.
			let outcome: BuildInstallPinResult;
			try {
				const devDeps: InstallDeps = {
					installer,
					appsRepo,
					dashboard,
					provenance: DEV_INSTALL_PROVENANCE,
				};
				outcome = build
					? await buildInstallPin(app, appsDir, devDeps)
					: await installPrebuiltBundle(app, join(appsDir, app.dir), devDeps);
			} catch (e) {
				result.errors.push(`${app.dir}: ${e instanceof Error ? e.message : String(e)}`);
				continue;
			}
			if (!outcome.ok) {
				result.errors.push(`${app.dir}: ${outcome.reason}`);
				continue;
			}
			if (outcome.unchanged) result.skipped += 1;
			else result.installed += 1;
			installedIds.add(outcome.id);
			if (outcome.pinned) result.pinned += 1;
		}
	});

	// Sweep orphan installs (registry says installed, bundle dir missing).
	// Restricted to apps NOT seeded this round, so freshly-installed ones
	// stay regardless of any cross-session inconsistency.
	for (const record of appsRepo.listActive()) {
		if (installedIds.has(record.id)) continue;
		const alive = await pathExists(record.bundleDir);
		if (alive) continue;
		await installer.uninstall(record.id);
	}

	// Drop dashboard icons whose app isn't installed (a click would error
	// NotInstalled) — using the final installed set.
	pruneOrphanAppIcons(dashboard, new Set(appsRepo.listActive().map((a) => a.id)));

	return result;
}

export type InstallDeps = {
	installer: AppInstaller;
	appsRepo: AppsRepository;
	dashboard: DashboardStore;
	/** Provenance stamped on the registry row (doc 59 / schema v9). Omitted →
	 *  the installer's `DEFAULT_INSTALL_PROVENANCE` (bootstrap-cache). The dev
	 *  seeder passes `DEV_INSTALL_PROVENANCE`; the production bootstrap
	 *  installer leaves it defaulted (bootstrap-cache). */
	provenance?: InstallProvenance;
};

export type InstallPrebuiltBundleResult =
	| { ok: true; id: string; pinned: boolean; unchanged?: boolean }
	| { ok: false; reason: string };

/**
 * Install a **pre-built** app bundle into the active vault and pin its
 * dashboard icon. Shared by the dev seeder (after `buildVitebundle`) and
 * the production seeder (which reads from `process.resourcesPath/apps`).
 *
 * The `bundleDir` MUST already contain `manifest.json` + `dist/` — no
 * spawn / no source build happens here. Re-install semantics: if the app
 * is already registered with the SAME bundle content hash, it is left in
 * place (`unchanged: true`) — uninstall/reinstall of an identical bundle
 * churned the registry every dev boot, which unpinned + re-pinned every
 * dashboard icon and made them flash their lettered fallbacks. A changed
 * bundle uninstalls first then re-installs, so an updated bundle on disk
 * still overrides the vault copy.
 */
export async function installPrebuiltBundle(
	app: FirstPartyApp,
	bundleDir: string,
	deps: InstallDeps,
): Promise<InstallPrebuiltBundleResult> {
	const existing = deps.appsRepo.getActive(app.expectedAppId);
	if (existing) {
		const sourceHash = await hashBundleDirectory(bundleDir, (abs) =>
			shouldCopyBundleEntry(bundleDir, abs),
		);
		if (sourceHash === existing.bundleSha256) {
			const pinned = placeDashboardIcon(deps.dashboard, existing.id, app.label);
			return { ok: true, id: existing.id, pinned, unchanged: true };
		}
		const uninstall = await deps.installer.uninstall(app.expectedAppId);
		if (!uninstall.ok) return { ok: false, reason: `reinstall: ${uninstall.reason}` };
	}

	const outcome = await deps.installer.install({
		bundleDir,
		...(deps.provenance ? { provenance: deps.provenance } : {}),
	});
	if (!outcome.ok) return { ok: false, reason: outcome.reason };

	// Provenance: the exact bundle sha just installed this boot. Compare
	// with the renderer's `[app:<id>] build …` line — if they differ, the
	// running window is stale (shell wasn't restarted). Turns the
	// session-long "is the fix even running?" mystery into one grep.
	console.info(`[seed] reinstalled ${outcome.app.id} build ${outcome.app.bundleSha256.slice(0, 8)}`);

	const pinned = placeDashboardIcon(deps.dashboard, outcome.app.id, app.label);
	return { ok: true, id: outcome.app.id, pinned };
}

type BuildInstallPinResult = InstallPrebuiltBundleResult;

/** Dev composition: build the app's source bundle (vite spawn) then call
 *  `installPrebuiltBundle`. Used by the dev seeder loop and the
 *  marketplace reinstall path. Uninstall vacuums the vault bundle, so the
 *  rebuild is mandatory — there's no cached copy to fall back to. */
async function buildInstallPin(
	app: FirstPartyApp,
	appsDir: string,
	deps: InstallDeps,
): Promise<BuildInstallPinResult> {
	const bundleDir = join(appsDir, app.dir);

	const buildResult = await buildVitebundle(bundleDir);
	if (!buildResult.ok) return { ok: false, reason: `build: ${buildResult.reason}` };

	return installPrebuiltBundle(app, bundleDir, deps);
}

export type ReinstallResult = { ok: true } | { ok: false; reason: string };

/**
 * Reinstall a single first-party app by manifest id — the marketplace's
 * "Install" affordance for a built-in app the user previously uninstalled.
 * Only ids in the first-party catalog are accepted; arbitrary paths can't
 * be installed through this path (the renderer never sends one).
 */
export async function reinstallFirstPartyApp(
	appId: string,
	appsDir: string,
): Promise<ReinstallResult> {
	const app = firstPartyAppById(appId);
	if (!app) return { ok: false, reason: `${appId} is not a first-party app` };

	const session = getActiveVaultSession();
	if (!session) return { ok: false, reason: "no active vault session" };

	const registry = await session.dataStores.open("registry");
	const ledger = await session.capabilityLedger();
	const shortcutRegistry = getActiveShortcutRegistry();
	const installer = new AppInstaller(
		session.vaultPath,
		registry,
		ledger,
		shortcutRegistry ?? undefined,
	);
	const appsRepo = new AppsRepository(registry);
	const dashboard = await session.dashboardStore();
	// Explicit reinstall = the user wants the app (and its icon) back, even if
	// they previously removed the icon from the dashboard.
	dashboard.clearAppIconDismissed(app.expectedAppId);

	const outcome = await buildInstallPin(app, appsDir, {
		installer,
		appsRepo,
		dashboard,
		provenance: DEV_INSTALL_PROVENANCE,
	});
	return outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason };
}

/** Place a dashboard icon at the next free grid cell. Returns false when
 *  an icon already targets this app (no-op for re-seeds).
 *
 *  Wire format is cell-index `{x: col, y: row}` (small integers) — matches
 *  the renderer's grid in `packages/shell/src/renderer/dashboard/grid.ts`.
 *  Storing pixel coordinates here would put `col=0` (`x=16`) below the
 *  legacy-detection threshold and strand it as `col=16` on the rendered
 *  grid (clamped off-screen). */
export function placeDashboardIcon(
	dashboard: DashboardStore,
	appId: string,
	label: string,
): boolean {
	// The user removed this app's icon on purpose — don't resurrect it.
	if (dashboard.isAppIconDismissed(appId)) return false;
	const existingIcons = Object.entries(dashboard.snapshot().icons);
	if (existingIcons.some(([, icon]) => icon.target === appId)) return false;

	const occupied = new Set(existingIcons.map(([, icon]) => keyFor(icon.x, icon.y)));
	let cursor = 0;
	while (true) {
		const col = cursor % GRID_COLS;
		const row = Math.floor(cursor / GRID_COLS);
		if (!occupied.has(keyFor(col, row))) {
			dashboard.upsertIcon(`icon_${appId}_demo`, {
				x: col,
				y: row,
				kind: "app",
				target: appId,
				label,
			});
			return true;
		}
		cursor += 1;
	}
}

function keyFor(x: number, y: number): string {
	return `${x}:${y}`;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/** Run `vite build` inside the app's directory. We shell out to `bun` so
 *  the per-app `package.json` scripts and workspace dependencies resolve
 *  the same way they do for the user typing `bun run build`.
 *
 *  Dev-only — the packaged-mode seeder reads prebuilt `dist/` from
 *  `process.resourcesPath/apps/<dir>/` and never spawns a child. */
async function buildVitebundle(
	appBundleDir: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	return new Promise((resolve) => {
		const child = spawn("bun", ["run", "build"], {
			cwd: appBundleDir,
			stdio: "pipe",
		});
		let stderr = "";
		// MUST drain BOTH pipes. `stdio:"pipe"` gives ~64 KB OS pipe
		// buffers; a child that fills an UNREAD pipe blocks on write and
		// never exits. Previously only stderr was consumed — Graph's vite
		// build emits far more stdout than any other app (3046 chunks +
		// the chunk-size warning + sourcemap lines), so its stdout pipe
		// filled, the build hung, `await buildVitebundle` never resolved,
		// and the whole seed loop stalled at Graph → Graph (and every app
		// after it) never reinstalled. Drain both pipes here so the
		// child can finish + exit.
		child.stdout?.on("data", () => {
			/* discard — we only need the exit code; consuming it unblocks
			   the child's writes so the build can finish + exit. */
		});
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", (error) => {
			resolve({ ok: false, reason: `failed to spawn build: ${error.message}` });
		});
		child.on("exit", (code) => {
			if (code === 0) resolve({ ok: true });
			else resolve({ ok: false, reason: `build exited with code ${code}: ${stderr.slice(-400)}` });
		});
	});
}
