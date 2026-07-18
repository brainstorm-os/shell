/**
 * `apps:*` IPC handlers — let the dashboard renderer read the installed-app
 * registry without going through the broker.
 *
 * Dashboard surfaces (icon picker, launcher) need the active app list to
 * resolve labels/icons and dispatch launches. App renderers cannot use these
 * handlers; their access to the registry is mediated by the broker via the
 * future `apps.list` capability.
 */

import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type BrowserWindow, ipcMain } from "electron";
import type { AppSignatureStatus } from "../apps/app-signature";
import { AppInstaller } from "../apps/installer";
import type { LaunchOrchestrator } from "../apps/launch-orchestrator";
import type { AppLauncher } from "../apps/launcher";
import { getActiveShortcutRegistry } from "../shortcuts/active-registry";
import { AppsRepository } from "../storage/registry-repo/apps-repo";
import { IntentsRepository } from "../storage/registry-repo/intents-repo";
import { getActiveVaultSession } from "../vault/session";
import { rebindDashboardToActiveVault, republishDashboardSnapshot } from "./dashboard-handlers";

/** The action-surface verbs that make an app a *contributor* (doc 63). An app
 *  with any such intent registration surfaces actions in other apps' menus. */
const CONTRIBUTED_VERB_SET: ReadonlySet<string> = new Set([
	"process",
	"convert",
	"share",
	"export",
	"insert",
	"compose",
]);

export type InstalledApp = {
	id: string;
	name: string;
	version: string;
	sdk: string;
	hasIcon: boolean;
	/** Short one-line description from the manifest. Surfaces in the
	 *  pinning picker and launcher so users can tell apps apart by purpose,
	 *  not just by name. */
	description?: string;
	/** Advisory manifest-signature status recorded at install (13.2):
	 *  'unsigned' | 'verified' | 'untrusted' | 'invalid'. */
	signatureStatus: AppSignatureStatus;
};

export const APPS_RUNNING_CHANGED_CHANNEL = "apps:running-changed" as const;

export type AppsHandlersOptions = {
	getOrchestrator: () => Promise<LaunchOrchestrator | null>;
	getLauncherSync: () => AppLauncher | null;
	onSessionRebuilt: (listener: () => void) => () => void;
	getDashboard: () => BrowserWindow | null;
	closeAppWindows: (appId: string) => void;
};

export type UninstallSummary = {
	ok: boolean;
	reason?: string;
	revokedCapabilities?: number;
	orphanedTypes?: number;
};

export function registerAppsHandlers(options: AppsHandlersOptions): void {
	ipcMain.handle("apps:list-installed", async (): Promise<InstalledApp[]> => {
		const session = getActiveVaultSession();
		if (!session) return [];
		let registry: Awaited<ReturnType<typeof session.dataStores.open>>;
		try {
			registry = await session.dataStores.open("registry");
		} catch (error) {
			// A fail-closed registry open (e.g. an at-rest key mismatch) must
			// surface as an empty list, not a rejected IPC the renderer reports
			// as an unhandled rejection. The vault is unusable until the key is
			// resolved; degrade quietly with a logged cause.
			console.warn(`[apps:list-installed] registry unavailable: ${(error as Error).message}`);
			return [];
		}
		const repo = new AppsRepository(registry);
		const records = repo.listActive();
		// Filter orphans (registry says installed, bundle dir missing) AND
		// lazily soft-uninstall them so the next list call is clean too.
		// This means the icon-picker never offers a broken app for pinning.
		const alive: typeof records = [];
		const orphans: typeof records = [];
		// Partition AFTER the parallel fs checks settle — pushing inside the
		// Promise.all callbacks ordered the result by fs-completion (racy), so
		// every consumer (per-app notification list, icon picker) got the apps
		// in a different order per call. The flags array preserves the repo's
		// ORDER BY.
		const orphaned = await Promise.all(
			records.map(async (record) => {
				try {
					await access(join(record.bundleDir, "manifest.json"));
					return false;
				} catch {
					return true;
				}
			}),
		);
		records.forEach((record, i) => {
			(orphaned[i] ? orphans : alive).push(record);
		});
		if (orphans.length > 0) {
			const ledger = await session.capabilityLedger();
			const shortcutRegistry = getActiveShortcutRegistry();
			const installer = new AppInstaller(
				session.vaultPath,
				registry,
				ledger,
				shortcutRegistry ?? undefined,
			);
			for (const orphan of orphans) {
				try {
					await installer.uninstall(orphan.id);
				} catch (error) {
					console.warn(`[apps:list-installed] failed to clean orphan ${orphan.id}:`, error);
				}
			}
		}
		return Promise.all(alive.map((record) => describeApp(record)));
	});

	ipcMain.handle("apps:launch", async (_event, appId: string): Promise<void> => {
		const orchestrator = await options.getOrchestrator();
		if (!orchestrator) {
			throw new Error("apps:launch — no active vault session");
		}
		await orchestrator.launch({ appId });
	});

	ipcMain.handle("apps:list-running", (): string[] => {
		return options.getLauncherSync()?.runningAppIds() ?? [];
	});

	// The action surface (doc 63 / AS-4): the app ids that contribute cross-app
	// actions — apps with at least one action-surface intent registration
	// (`process`/`convert`/`share`/`export`/`insert`). Drives the Settings →
	// Apps & contributions toggle (an app with no contributions has nothing to
	// disable). Read-only registry query; empty list on a fail-closed open.
	ipcMain.handle("apps:list-contributing", async (): Promise<string[]> => {
		const session = getActiveVaultSession();
		if (!session) return [];
		let registry: Awaited<ReturnType<typeof session.dataStores.open>>;
		try {
			registry = await session.dataStores.open("registry");
		} catch (error) {
			console.warn(`[apps:list-contributing] registry unavailable: ${(error as Error).message}`);
			return [];
		}
		const intentsRepo = new IntentsRepository(registry);
		const appsRepo = new AppsRepository(registry);
		const ids = new Set<string>();
		for (const record of appsRepo.listActive()) {
			const contributes = intentsRepo
				.listForApp(record.id)
				.some((row) => CONTRIBUTED_VERB_SET.has(row.verb));
			if (contributes) ids.add(record.id);
		}
		return [...ids].sort();
	});

	/** Uninstall an app: close its live windows, revoke capabilities, mark
	 *  the registry row uninstalled, orphan its entity types, then remove
	 *  any dashboard icons pinned at it. Bundle dir is vacuumed too so the
	 *  next install of the same app id starts from a clean slate. */
	ipcMain.handle("apps:uninstall", async (_event, appId: string): Promise<UninstallSummary> => {
		const session = getActiveVaultSession();
		if (!session) return { ok: false, reason: "no active vault session" };

		options.closeAppWindows(appId);

		const registry = await session.dataStores.open("registry");
		const ledger = await session.capabilityLedger();
		const shortcutRegistry = getActiveShortcutRegistry();
		const installer = new AppInstaller(
			session.vaultPath,
			registry,
			ledger,
			shortcutRegistry ?? undefined,
		);
		const result = await installer.uninstall(appId);
		if (!result.ok) return { ok: false, reason: result.reason };

		try {
			await installer.vacuumBundles(appId);
		} catch (error) {
			console.warn(`[apps:uninstall] vacuumBundles failed for ${appId}:`, error);
		}

		const dashboard = await session.dashboardStore();
		const icons = dashboard.snapshot().icons;
		for (const [iconId, icon] of Object.entries(icons)) {
			if (icon.kind === "app" && icon.target === appId) {
				dashboard.removeIcon(iconId);
			}
		}
		// The removals above only reach the renderer through the dashboard
		// snapshot subscription — which this handler doesn't self-heal the way
		// the `dashboard:*` mutators do, so a subscription left pointing at a
		// previous session's store would silently drop the push and the
		// uninstalled app's tile would linger until a manual reload. Re-bind
		// to the active store and push out-of-band so the renderer always
		// sees the post-uninstall truth.
		await rebindDashboardToActiveVault();
		republishDashboardSnapshot();

		return {
			ok: true,
			revokedCapabilities: result.revokedCapabilities,
			orphanedTypes: result.orphanedTypes,
		};
	});

	let detachLauncherListener: (() => void) | null = null;

	function rebindLauncher(): void {
		detachLauncherListener?.();
		detachLauncherListener = null;
		const launcher = options.getLauncherSync();
		if (!launcher) return;
		detachLauncherListener = launcher.onWindowsChanged(() => {
			const dashboard = options.getDashboard();
			if (!dashboard || dashboard.isDestroyed()) return;
			dashboard.webContents.send(APPS_RUNNING_CHANGED_CHANNEL, launcher.runningAppIds());
		});
	}

	options.onSessionRebuilt(rebindLauncher);
	rebindLauncher();
}

type AppRecord = {
	id: string;
	version: string;
	sdk: string;
	bundleDir: string;
	signatureStatus: AppSignatureStatus;
};

async function describeApp(record: AppRecord): Promise<InstalledApp> {
	const manifestPath = join(record.bundleDir, "manifest.json");
	let name = record.id;
	let hasIcon = false;
	let description: string | undefined;
	try {
		const raw = await readFile(manifestPath, "utf8");
		const manifest = JSON.parse(raw) as {
			name?: unknown;
			icon?: unknown;
			description?: unknown;
		};
		if (typeof manifest.name === "string" && manifest.name.length > 0) {
			name = manifest.name;
		}
		hasIcon = typeof manifest.icon === "string" && manifest.icon.length > 0;
		if (typeof manifest.description === "string" && manifest.description.length > 0) {
			description = manifest.description;
		}
	} catch {
		// Manifest unreadable — fall through with id as the display name.
	}
	return {
		id: record.id,
		name,
		version: record.version,
		sdk: record.sdk,
		hasIcon,
		signatureStatus: record.signatureStatus,
		...(description !== undefined ? { description } : {}),
	};
}
