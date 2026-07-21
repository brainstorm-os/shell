/**
 * `marketplace:*` IPC handlers — surface the unified marketplace listings
 * (apps + themes today; plugin / layout-pack / wallpaper-pack / locale-pack /
 * workflow-pack / shortcut-pack later) to the dashboard renderer.
 *
 * The marketplace overlay is a privileged shell view (per
 *  §The Marketplace surface is part of the shell),
 * so it talks to ipcMain directly — never through the broker. Mirrors the
 * `dashboard:*` / `properties:*` patterns.
 *
 * The activate-theme handler proxies to the existing `dashboard:set-theme`
 * path so the marketplace and Settings → Themes both converge on the same
 * `DashboardStore.setTheme()` invariant.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ThemeName, isThemeName } from "@brainstorm-os/tokens";
import { app, ipcMain, nativeTheme } from "electron";
import { effectiveSlotFor } from "../../shared/appearance";
import { UpdateChannel } from "../../shared/update-wire-types";
import { firstPartyAppsDir, readFirstPartyCatalog } from "../apps/first-party";
import { AppInstaller } from "../apps/installer";
import {
	ensureCatalogRefreshed,
	getCatalogClient,
	makeInstallEngine,
	makeUpdateEngine,
} from "../catalog/catalog-runtime";
import { InstallOutcome } from "../catalog/install-engine";
import { type UpdateClassification, UpdateOutcome } from "../catalog/update-engine";
import {
	type ReinstallResult,
	placeDashboardIcon,
	reinstallFirstPartyApp,
} from "../dev/seed-demo-apps";
import type { MarketplaceListing } from "../marketplace/listing";
import {
	BUILTIN_SOURCE,
	BUILTIN_SOURCE_NAME,
	type InstalledAppRecord,
	MarketplaceService,
	type MarketplaceSource,
	type RemoteCatalogListing,
} from "../marketplace/marketplace-service";
import { getActiveShortcutRegistry } from "../shortcuts/active-registry";
import { AppsRepository } from "../storage/registry-repo/apps-repo";
import { getActiveVaultSession } from "../vault/session";

export const MARKETPLACE_LISTINGS_CHANNEL = "marketplace:listings" as const;
export const MARKETPLACE_INSTALLED_CHANNEL = "marketplace:installed" as const;
export const MARKETPLACE_SOURCES_CHANNEL = "marketplace:sources" as const;
export const MARKETPLACE_INSTALL_CHANNEL = "marketplace:install" as const;
export const MARKETPLACE_CHECK_UPDATES_CHANNEL = "marketplace:check-updates" as const;
export const MARKETPLACE_APPLY_UPDATE_CHANNEL = "marketplace:apply-update" as const;
export const MARKETPLACE_ACTIVATE_THEME_CHANNEL = "marketplace:activate-theme" as const;

/** Wire shape for an available update (the renderer's `MarketplaceUpdate`). The
 *  main process can't import preload types, so the shape is declared here and
 *  kept in sync with `preload/marketplace-types.ts`. */
type MarketplaceUpdateDto = {
	id: string;
	name: string;
	fromVersion: string;
	toVersion: string;
	classification: UpdateClassification;
	newCapabilities: string[];
};

export type MarketplaceHandlersOptions = {
	/** `__dirname` of the main process entry — resolves the first-party
	 *  `apps/` tree the same way the dev seeder does. */
	mainDir: string;
};

export function registerMarketplaceHandlers(options: MarketplaceHandlersOptions): void {
	const appsDir = firstPartyAppsDir(options.mainDir);

	ipcMain.handle(MARKETPLACE_LISTINGS_CHANNEL, async (): Promise<MarketplaceListing[]> => {
		const service = await buildService(appsDir);
		if (!service) return [];
		return service.listings();
	});

	ipcMain.handle(MARKETPLACE_INSTALLED_CHANNEL, async (): Promise<MarketplaceListing[]> => {
		const service = await buildService(appsDir);
		if (!service) return [];
		return service.installed();
	});

	ipcMain.handle(
		MARKETPLACE_INSTALL_CHANNEL,
		async (_event, appId: string): Promise<ReinstallResult> => {
			if (typeof appId !== "string" || appId.length === 0) {
				return { ok: false, reason: "invalid app id" };
			}
			return installFromCatalogOrReinstall(appId, appsDir);
		},
	);

	ipcMain.handle(MARKETPLACE_CHECK_UPDATES_CHANNEL, async (): Promise<MarketplaceUpdateDto[]> => {
		const session = getActiveVaultSession();
		if (!session) return [];
		const { client, engine } = await buildUpdateEngine(session);
		return (await engine.check()).map((u) => ({
			id: u.id,
			name: client.listing(u.id)?.name ?? u.id,
			fromVersion: u.fromVersion,
			toVersion: u.toVersion,
			classification: u.classification,
			newCapabilities: u.newCapabilities,
		}));
	});

	ipcMain.handle(
		MARKETPLACE_APPLY_UPDATE_CHANNEL,
		async (_event, appId: string): Promise<ReinstallResult> => {
			if (typeof appId !== "string" || appId.length === 0) {
				return { ok: false, reason: "invalid app id" };
			}
			const session = getActiveVaultSession();
			if (!session) return { ok: false, reason: "no active vault session" };
			const { engine } = await buildUpdateEngine(session);
			const candidate = (await engine.check()).find((u) => u.id === appId);
			if (!candidate) return { ok: false, reason: `no update available for ${appId}` };
			const result = await engine.apply(candidate);
			return result.outcome === UpdateOutcome.Updated
				? { ok: true }
				: { ok: false, reason: result.reason };
		},
	);

	ipcMain.handle(MARKETPLACE_SOURCES_CHANNEL, async (): Promise<MarketplaceSource[]> => {
		// v1: only the built-in source ships. Remote catalogs add entries
		// here as they come online (per 47-marketplace.md §Distribution
		// channels). The list shape is stable so callers don't churn.
		return [BUILTIN_SOURCE];
	});

	ipcMain.handle(
		MARKETPLACE_ACTIVATE_THEME_CHANNEL,
		async (_event, theme: string): Promise<boolean> => {
			const session = getActiveVaultSession();
			if (!session) {
				console.warn("[brainstorm] marketplace:activate-theme: no active vault session");
				return false;
			}
			if (!isThemeName(theme)) {
				console.warn(`[brainstorm] marketplace:activate-theme: unknown theme ${theme}`);
				return false;
			}
			const store = await session.dashboardStore();
			store.setTheme(theme);
			return true;
		},
	);
}

/**
 * Install an app via the remote catalog when it's listed there (download →
 * verify sha256 + Ed25519 → unpack → install + pin the dashboard icon); else
 * fall back to the dev first-party reinstall (build-from-source). The catalog
 * path is the production install; the reinstall path is the dev seeder's
 * "bring a built-in back" affordance.
 */
async function installFromCatalogOrReinstall(
	appId: string,
	appsDir: string,
): Promise<ReinstallResult> {
	const session = getActiveVaultSession();
	if (!session) return { ok: false, reason: "no active vault session" };

	const client = getCatalogClient(app.getPath("userData"));
	await ensureCatalogRefreshed(client);
	const listing = client.listing(appId);
	if (!listing) return reinstallFirstPartyApp(appId, appsDir);

	const registry = await session.dataStores.open("registry");
	const ledger = await session.capabilityLedger();
	const installer = new AppInstaller(
		session.vaultPath,
		registry,
		ledger,
		getActiveShortcutRegistry() ?? undefined,
	);
	const engine = makeInstallEngine(client, installer);
	const result = await engine.install(appId, UpdateChannel.Stable);
	if (result.outcome !== InstallOutcome.Installed) {
		return { ok: false, reason: result.reason };
	}
	// Catalog installs aren't seeded, so pin the dashboard icon like the seeder does.
	placeDashboardIcon(await session.dashboardStore(), appId, listing.name);
	return { ok: true };
}

/** Build an UpdateEngine for the active vault (catalog refreshed). Auto-update
 *  stays off (manual via the Updates surface) until a user setting exists. */
async function buildUpdateEngine(session: NonNullable<ReturnType<typeof getActiveVaultSession>>) {
	const client = getCatalogClient(app.getPath("userData"));
	await ensureCatalogRefreshed(client);
	const registry = await session.dataStores.open("registry");
	const ledger = await session.capabilityLedger();
	const installer = new AppInstaller(
		session.vaultPath,
		registry,
		ledger,
		getActiveShortcutRegistry() ?? undefined,
	);
	const repo = new AppsRepository(registry);
	return { client, engine: makeUpdateEngine(client, installer, repo, () => false) };
}

async function readAppManifestMeta(
	bundleDir: string,
	fallbackName: string,
): Promise<{ name: string; description?: string }> {
	try {
		const raw = await readFile(join(bundleDir, "manifest.json"), "utf8");
		const manifest = JSON.parse(raw) as { name?: unknown; description?: unknown };
		const name =
			typeof manifest.name === "string" && manifest.name.length > 0 ? manifest.name : fallbackName;
		const description =
			typeof manifest.description === "string" && manifest.description.length > 0
				? manifest.description
				: undefined;
		return description !== undefined ? { name, description } : { name };
	} catch {
		// Manifest unreadable — fall through to the id.
	}
	return { name: fallbackName };
}

/** Remote-catalog listings (the official catalog), mapped to the marketplace's
 *  `RemoteCatalogListing` shape — the `stable` channel's current version. Reads
 *  the cached signed index (refreshed at most once per boot); returns [] when
 *  the catalog is unreachable so the surface degrades to built-in only. */
async function remoteCatalogListings(): Promise<RemoteCatalogListing[]> {
	try {
		const client = getCatalogClient(app.getPath("userData"));
		await ensureCatalogRefreshed(client);
		const out: RemoteCatalogListing[] = [];
		for (const listing of client.listings()) {
			const version = listing.channels[UpdateChannel.Stable];
			if (!version) continue;
			out.push({
				id: listing.id,
				name: listing.name,
				version,
				...(listing.summary ? { summary: listing.summary } : {}),
				sourceName: BUILTIN_SOURCE_NAME,
			});
		}
		return out;
	} catch {
		return [];
	}
}

async function buildService(appsDir: string): Promise<MarketplaceService | null> {
	const session = getActiveVaultSession();
	if (!session) return null;
	const registry = await session.dataStores.open("registry");
	const repo = new AppsRepository(registry);
	return new MarketplaceService({
		listRemoteCatalogListings: remoteCatalogListings,
		listCatalogApps: async (): Promise<InstalledAppRecord[]> => {
			const catalog = await readFirstPartyCatalog(appsDir);
			return catalog.map((entry) => ({
				id: entry.id,
				name: entry.name,
				version: entry.version,
				...(entry.description !== undefined ? { description: entry.description } : {}),
			}));
		},
		listInstalledApps: async (): Promise<InstalledAppRecord[]> => {
			const records = repo.listActive();
			return Promise.all(
				records.map(async (record) => {
					const meta = await readAppManifestMeta(record.bundleDir, record.id);
					return {
						id: record.id,
						name: meta.name,
						version: record.version,
						...(meta.description !== undefined ? { description: meta.description } : {}),
					};
				}),
			);
		},
		getActiveTheme: async (): Promise<ThemeName | null> => {
			const store = await session.dashboardStore();
			const snap = store.snapshot();
			const slot = effectiveSlotFor(snap.appearance.mode, nativeTheme.shouldUseDarkColors);
			return store.snapshot(slot).theme;
		},
	});
}
