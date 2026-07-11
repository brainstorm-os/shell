/**
 * `dashboard:*` IPC handlers — let the dashboard renderer read + mutate the
 * shell-owned dashboard surface (icons, widgets, wallpaper).
 *
 * The dashboard is a shell-trusted surface, so it talks directly to the
 * DashboardStore — not via the broker. Apps publish widgets *into* the
 * dashboard via a future `ui.dashboard.publishWidget` capability route
 * (Stage 7.3 wires that on the broker side).
 *
 * Stage 7.2 ships: subscribe + icon CRUD + wallpaper set. Stage 7.3 adds
 * widget publish/unpublish from app land. Stage 7.9 surfaces a wallpaper
 * picker UI on top of the same `set-wallpaper` channel.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { FormatContext, PinResolution, ThemePreviewPayload } from "@brainstorm/sdk-types";
import { type ThemeName, isThemeName, themes } from "@brainstorm/tokens";
import { type BrowserWindow, app, dialog, ipcMain, nativeImage, nativeTheme } from "electron";
import {
	AppearanceSlot,
	effectiveSlotFor,
	isAppearanceMode,
	isAppearanceSlot,
} from "../../shared/appearance";
import { regionalToFormatContext, sameFormatContext } from "../../shared/format-context";
import {
	type ClockPrefs,
	type DndPrefs,
	type HeaderControlId,
	type RegionalState,
	isHeaderControlId,
} from "../../shared/shell-prefs";
import { resolveAppName } from "../apps/app-name";
import { type AppWindow, isAppWindowLive } from "../apps/launcher";
import { type MediaSeal, VaultMediaDomain, isSealedMedia } from "../assets/vault-media-crypto";
import {
	type DashboardSnapshot,
	type DashboardStore,
	type IconRecord,
	type Wallpaper,
	type WidgetRecord,
	defaultHandlerKey,
} from "../dashboard/dashboard-store";
import { resolvePins } from "../dashboard/pin-resolver";
import {
	DEFAULT_HANDLER_VERB,
	type DefaultsCatalog,
	GENERIC_OBJECT_EDITOR_APP_ID,
	buildDefaultsCatalog,
} from "../intents/defaults-catalog";
import { EntitiesRepository } from "../storage/entities-repo";
import { AppsRepository } from "../storage/registry-repo/apps-repo";
import { EntityTypesRepository } from "../storage/registry-repo/entity-types-repo";
import { IntentsRepository } from "../storage/registry-repo/intents-repo";
import { OpenerTargetKind, OpenersRepository } from "../storage/registry-repo/openers-repo";
import { WidgetsRepository } from "../storage/registry-repo/widgets-repo";
import { type VaultSession, getActiveVaultSession } from "../vault/session";

export const DASHBOARD_SNAPSHOT_CHANNEL = "dashboard:snapshot";
/** App-renderer-bound channel: payload is the active theme *name*
 *  (`"midnight"`, `"default-dark"`, …). Mirrors the bootstrap payload the
 *  app preload reads from `--brainstorm-theme=…`. The preload resolves
 *  the name through the bundled `@brainstorm/tokens` registry — no
 *  flattened-map shipping over IPC. */
export const APP_THEME_CHANGED_CHANNEL = "app:theme-changed";

/** App-renderer-bound channel: payload is the active UI locale (BCP-47 tag).
 *  Sibling of `APP_THEME_CHANGED_CHANNEL` — the app preload feeds it into the
 *  SDK runtime so `runtime.locale` updates + `onLocaleChange` handlers fire
 *  without a window relaunch (12.15). */
export const APP_LOCALE_CHANGED_CHANNEL = "app:locale-changed";

/** Per-tab signal that the regional-format context changed (12.15 slice 15f).
 *  Sibling of `APP_LOCALE_CHANGED_CHANNEL` — the app preload feeds it into the
 *  SDK runtime so `runtime.format` updates + `onFormatChange` handlers fire when
 *  the user edits a Settings → Regional value, no relaunch. */
export const APP_FORMAT_CHANGED_CHANNEL = "app:format-changed";

/** Transient theme-preview channel (9.9.6). Carries a sanitized
 *  `ThemePreviewPayload` to paint over the committed theme, or `null` to
 *  revert. The renderer applies the vars via CSSOM `setProperty` (never
 *  string-built into a stylesheet), so the already-sanitized values can't
 *  break out — defence in depth. */
export const APP_THEME_PREVIEW_CHANNEL = "app:theme-preview";

type DashboardTargetGetter = () => BrowserWindow | null;
type AppWindowsGetter = () => readonly AppWindow[];

let subscribedStore: DashboardStore | null = null;
let unsubscribe: (() => void) | null = null;
let getAppWindowsRef: AppWindowsGetter | null = null;
let getDashboardRef: DashboardTargetGetter | null = null;

/** Stage 7.3 — driven on every dashboard snapshot so the WidgetHostController
 *  reconciles its native widget surfaces against the placed-widget set (and
 *  picks up the active theme/locale/format for a new surface's first paint).
 *  Set once at startup by `index.ts`; left null in test contexts. */
export type WidgetSnapshotHook = (args: {
	widgets: Record<string, { appId: string; kind: string }>;
	theme: ThemeName;
	locale: string;
	format: FormatContext;
}) => void;
let widgetSnapshotHook: WidgetSnapshotHook | null = null;
export function setWidgetSnapshotHook(hook: WidgetSnapshotHook | null): void {
	widgetSnapshotHook = hook;
}

/** One entry in the add-widget picker catalog — a widget an installed app
 *  offers (registry `widgets` row) tagged with its app's display name. */
export type RegisteredWidget = {
	appId: string;
	appName: string;
	/** Manifest widget id (registry `widgets.id`) — the placement's `kind`. */
	widgetId: string;
	name: string;
	size: "small" | "medium" | "large";
};
let lastBroadcastTheme: ThemeName | null = null;
let lastBroadcastLanguage: string | null = null;
let lastBroadcastFormat: FormatContext | null = null;

/**
 * Guards dashboard-snapshot delivery against out-of-order async resolution.
 *
 * `enrichSnapshot` reads the store *synchronously* at call time but only
 * resolves after an `await` when the vault has entity pins (it reads the
 * registry/entities DBs to resolve their live presentation). Two snapshot
 * pushes triggered close together — e.g. toggling several header controls in
 * the Interface settings — therefore run as two concurrent enrichments that can
 * resolve in either order. If the *earlier* one (carrying the now-stale chrome)
 * resolves last, the renderer paints it last and a just-toggled control snaps
 * back: saving reads as "unreliable — only some toggles stick".
 *
 * Stamp each enrichment with a monotonic sequence claimed at push time (push
 * order == state-recency order, since the snapshot is captured synchronously)
 * and drop any whose result arrives after a newer snapshot has already been
 * sent. The newest enrichment always reads the newest state and is never
 * dropped, so the final painted snapshot is always the freshest one.
 */
export function createSnapshotSequencer(): {
	claim: () => number;
	shouldSend: (seq: number) => boolean;
} {
	let next = 0;
	let lastSent = -1;
	return {
		claim: () => next++,
		shouldSend: (seq: number) => {
			if (seq < lastSent) return false;
			lastSent = seq;
			return true;
		},
	};
}

const snapshotSequencer = createSnapshotSequencer();

/** The dashboard wire snapshot plus the live-resolved pin presentation
 *  (Stage 7.13). The store stays pure (no entity access); enrichment
 *  lives here because only the IPC layer has the vault session. */
export type EnrichedDashboardSnapshot = DashboardSnapshot & {
	pins: Record<string, PinResolution>;
};

/** Which app `intent.open` routes `entityType` to — the user's
 *  Settings → Defaults override wins, else the first registered opener,
 *  else the first `open` intent handler. Mirrors the `capableApps` /
 *  `currentDefaults` precedence the defaults-catalog handler below uses
 *  (same registry repos) so the pin badge and the open dispatch never
 *  disagree. `null` when nothing handles the type. */
function resolveOpenerAppId(
	entityType: string,
	defaultHandlers: Record<string, string>,
	openersRepo: OpenersRepository,
	intentsRepo: IntentsRepository,
): string | null {
	const pinned = defaultHandlers[defaultHandlerKey(DEFAULT_HANDLER_VERB, entityType)];
	if (pinned) return pinned;
	const fromOpeners = openersRepo
		.listForTarget(OpenerTargetKind.EntityType, entityType)
		.map((o) => o.appId);
	if (fromOpeners[0]) return fromOpeners[0];
	const fromIntents = intentsRepo
		.findHandlers({ verb: DEFAULT_HANDLER_VERB, entityType })
		.map((h) => h.appId);
	return fromIntents[0] ?? null;
}

/** Read the OS prefers-color-scheme via Electron's `nativeTheme` so the
 *  store snapshot can mirror the active pair (when in Auto mode). The
 *  renderer also runs its own `matchMedia` watcher for instant repaint;
 *  this is the main-side anchor that feeds every snapshot push (including
 *  app-window theme broadcasts). */
function osPrefersDark(): boolean {
	try {
		return nativeTheme.shouldUseDarkColors;
	} catch {
		// nativeTheme is unavailable in non-Electron contexts (tests).
		return true;
	}
}

/** Snapshot + live pin resolution. Skips the registry/entities reads
 *  entirely when there are no entity pins (the common case — app icons
 *  only), so the dashboard read stays cheap. */
async function enrichSnapshot(
	session: VaultSession,
	store: DashboardStore,
): Promise<EnrichedDashboardSnapshot> {
	const rawAppearance = store.snapshot().appearance;
	const effectiveSlot = effectiveSlotFor(rawAppearance.mode, osPrefersDark());
	const snap = store.snapshot(effectiveSlot);
	const hasEntityPin = Object.values(snap.icons).some((i) => i.kind === "entity");
	if (!hasEntityPin) return { ...snap, pins: {} };
	const registry = await session.dataStores.open("registry");
	const openersRepo = new OpenersRepository(registry);
	const intentsRepo = new IntentsRepository(registry);
	const appsRepo = new AppsRepository(registry);
	const entitiesRepo = new EntitiesRepository(await session.dataStores.open("entities"));
	const pins = resolvePins(snap.icons, {
		getEntity: (id) => {
			const row = entitiesRepo.get(id);
			return row ? { type: row.type, properties: row.properties } : null;
		},
		resolveOpenerApp: (type) =>
			resolveOpenerAppId(type, snap.defaultHandlers, openersRepo, intentsRepo),
		resolveAppName: (appId) => resolveAppName(appsRepo, appId),
	});
	return { ...snap, pins };
}

/**
 * Re-push the enriched dashboard snapshot to the renderer out-of-band —
 * called when an entity changes (rename / re-icon / delete / restore)
 * so a pinned tile reflects it without the user touching the dashboard
 * doc (OQ-DASH-1: resolution is live). No-op if the dashboard isn't
 * subscribed yet or there's no session.
 */
export function republishDashboardSnapshot(): void {
	const target = getDashboardRef?.() ?? null;
	if (!target || target.isDestroyed() || !subscribedStore) return;
	const session = getActiveVaultSession();
	if (!session) return;
	const store = subscribedStore;
	const seq = snapshotSequencer.claim();
	void enrichSnapshot(session, store)
		.then((enriched) => {
			if (!target.isDestroyed() && snapshotSequencer.shouldSend(seq)) {
				target.webContents.send(DASHBOARD_SNAPSHOT_CHANNEL, enriched);
			}
		})
		.catch((error) => {
			console.warn("[brainstorm] republishDashboardSnapshot failed:", error);
		});
}

/**
 * Re-point the dashboard subscription at the active vault's store and push its
 * snapshot to the renderer. Called on every vault open/switch: the dashboard
 * window persists across a switch (it isn't remounted), so without this the
 * renderer keeps showing the *previous* vault's theme / wallpaper / pinned
 * icons until it happens to re-fetch. `ensureSubscribed` no-ops when the store
 * identity is unchanged, so a re-open of the same vault won't double-push.
 */
export async function rebindDashboardToActiveVault(): Promise<void> {
	const getDashboard = getDashboardRef;
	if (!getDashboard) return;
	const session = getActiveVaultSession();
	if (!session) return;
	const store = await session.dashboardStore();
	await ensureSubscribed(store, getDashboard);
}

export function registerDashboardHandlers(
	getDashboard: DashboardTargetGetter,
	getAppWindows?: AppWindowsGetter,
): void {
	getAppWindowsRef = getAppWindows ?? null;
	getDashboardRef = getDashboard;

	/** Run `fn` against the active vault's dashboard store, after ensuring the
	 *  renderer subscription is live. No-ops (logs nothing) when no vault is
	 *  open. Shared by the shell-prefs mutators below so each handler is one
	 *  line of validation + the store call. */
	const withStore = async (fn: (store: DashboardStore) => void): Promise<void> => {
		const session = getActiveVaultSession();
		if (!session) return;
		const store = await session.dashboardStore();
		await ensureSubscribed(store, getDashboard);
		fn(store);
	};

	ipcMain.handle("dashboard:snapshot", async (): Promise<EnrichedDashboardSnapshot | null> => {
		const session = getActiveVaultSession();
		if (!session) return null;
		const store = await session.dashboardStore();
		await ensureSubscribed(store, getDashboard);
		return await enrichSnapshot(session, store);
	});

	ipcMain.handle(
		"dashboard:upsert-icon",
		async (_event, id: string, record: IconRecord): Promise<void> => {
			await withStore((store) => store.upsertIcon(id, record));
		},
	);

	ipcMain.handle(
		"dashboard:move-icon",
		async (_event, id: string, x: number, y: number): Promise<void> => {
			await withStore((store) => store.moveIcon(id, x, y));
		},
	);

	ipcMain.handle("dashboard:remove-icon", async (_event, id: string): Promise<void> => {
		await withStore((store) => store.removeIcon(id));
	});

	ipcMain.handle("dashboard:mark-icon-grid-migrated", async (): Promise<void> => {
		await withStore((store) => store.setIconGridMigrated());
	});

	ipcMain.handle(
		"dashboard:set-wallpaper",
		async (_event, wallpaper: Wallpaper, slot?: string): Promise<void> => {
			const session = getActiveVaultSession();
			if (!session) {
				console.warn("[brainstorm] dashboard:set-wallpaper: no active vault session");
				return;
			}
			const store = await session.dashboardStore();
			await ensureSubscribed(store, getDashboard);
			const target = isAppearanceSlot(slot)
				? slot
				: effectiveSlotFor(store.snapshot().appearance.mode, osPrefersDark());
			store.setWallpaper(wallpaper, target);
		},
	);

	ipcMain.handle("dashboard:set-theme", async (_event, theme: string): Promise<void> => {
		const session = getActiveVaultSession();
		if (!session) {
			console.warn("[brainstorm] dashboard:set-theme: no active vault session");
			return;
		}
		if (!isThemeName(theme)) {
			console.warn(`[brainstorm] dashboard:set-theme: unknown theme ${theme}`);
			return;
		}
		const store = await session.dashboardStore();
		await ensureSubscribed(store, getDashboard);
		store.setTheme(theme);
	});

	ipcMain.handle("dashboard:set-appearance-mode", async (_event, mode: string): Promise<void> => {
		const session = getActiveVaultSession();
		if (!session) {
			console.warn("[brainstorm] dashboard:set-appearance-mode: no active vault session");
			return;
		}
		if (!isAppearanceMode(mode)) {
			console.warn(`[brainstorm] dashboard:set-appearance-mode: unknown mode ${mode}`);
			return;
		}
		const store = await session.dashboardStore();
		await ensureSubscribed(store, getDashboard);
		store.setAppearanceMode(mode);
	});

	ipcMain.handle(
		"dashboard:set-appearance-pair",
		async (_event, slot: string, pair: { theme: string; wallpaper: Wallpaper }): Promise<void> => {
			const session = getActiveVaultSession();
			if (!session) return;
			if (!isAppearanceSlot(slot)) {
				console.warn(`[brainstorm] dashboard:set-appearance-pair: unknown slot ${slot}`);
				return;
			}
			if (!isThemeName(pair?.theme)) {
				console.warn(`[brainstorm] dashboard:set-appearance-pair: unknown theme ${pair?.theme}`);
				return;
			}
			if (!pair?.wallpaper || typeof pair.wallpaper.value !== "string") return;
			const store = await session.dashboardStore();
			await ensureSubscribed(store, getDashboard);
			store.setAppearancePair(slot, {
				theme: pair.theme,
				wallpaper: pair.wallpaper,
			});
		},
	);

	ipcMain.handle(
		"dashboard:set-default-handler",
		async (_event, verb: string, entityType: string, appId: string | null): Promise<void> => {
			const session = getActiveVaultSession();
			if (!session) {
				console.warn("[brainstorm] dashboard:set-default-handler: no active vault session");
				return;
			}
			if (typeof verb !== "string" || verb.length === 0) return;
			if (typeof entityType !== "string" || entityType.length === 0) return;
			const normalizedAppId = typeof appId === "string" && appId.length > 0 ? appId : null;
			const store = await session.dashboardStore();
			await ensureSubscribed(store, getDashboard);
			store.setDefaultHandler(verb, entityType, normalizedAppId);
		},
	);

	// The action surface (doc 63 / AS-4): disable or re-enable an app's
	// contributed actions wholesale (Settings → an app's contributions). The
	// intents bus drops a disabled app's contributions from `suggestActions`.
	ipcMain.handle(
		"dashboard:set-contributor-disabled",
		async (_event, appId: string, disabled: boolean): Promise<void> => {
			if (typeof appId !== "string" || appId.length === 0) return;
			await withStore((store) => store.setContributorDisabled(appId, disabled === true));
		},
	);

	// --- Shell prefs: language / regional / interface / notifications ---

	ipcMain.handle(
		"dashboard:set-language",
		(_event, language: string): Promise<void> =>
			withStore((store) => {
				if (typeof language === "string" && language.length > 0) store.setLanguage(language);
			}),
	);

	ipcMain.handle(
		"dashboard:set-regional",
		(_event, partial: Partial<RegionalState>): Promise<void> =>
			withStore((store) => {
				if (partial && typeof partial === "object") store.setRegional(partial);
			}),
	);

	ipcMain.handle(
		"dashboard:set-header-control-visible",
		(_event, id: string, visible: boolean): Promise<void> =>
			withStore((store) => {
				if (isHeaderControlId(id) && typeof visible === "boolean") {
					store.setHeaderControlVisible(id as HeaderControlId, visible);
				}
			}),
	);

	ipcMain.handle(
		"dashboard:set-clock-prefs",
		(_event, partial: Partial<ClockPrefs>): Promise<void> =>
			withStore((store) => {
				if (partial && typeof partial === "object") store.setClockPrefs(partial);
			}),
	);

	ipcMain.handle(
		"dashboard:reset-chrome",
		(): Promise<void> => withStore((store) => store.resetChrome()),
	);

	ipcMain.handle(
		"dashboard:set-notifications-os-native",
		(_event, osNative: boolean): Promise<void> =>
			withStore((store) => {
				if (typeof osNative === "boolean") store.setNotificationsOsNative(osNative);
			}),
	);

	ipcMain.handle(
		"dashboard:set-dnd",
		(_event, partial: Partial<DndPrefs>): Promise<void> =>
			withStore((store) => {
				if (partial && typeof partial === "object") store.setDnd(partial);
			}),
	);

	ipcMain.handle(
		"dashboard:set-app-notification-muted",
		(_event, appId: string, muted: boolean): Promise<void> =>
			withStore((store) => {
				if (typeof appId === "string" && appId.length > 0 && typeof muted === "boolean") {
					store.setAppNotificationMuted(appId, muted);
				}
			}),
	);

	ipcMain.handle(
		"dashboard:mark-notification-read",
		(_event, id: string): Promise<void> =>
			withStore((store) => {
				if (typeof id === "string" && id.length > 0) store.markNotificationRead(id);
			}),
	);

	ipcMain.handle(
		"dashboard:mark-all-notifications-read",
		(): Promise<void> => withStore((store) => store.markAllNotificationsRead()),
	);

	ipcMain.handle(
		"dashboard:clear-notification-history",
		(): Promise<void> => withStore((store) => store.clearNotificationHistory()),
	);

	ipcMain.handle("dashboard:defaults-catalog", async (): Promise<DefaultsCatalog | null> => {
		const session = getActiveVaultSession();
		if (!session) return null;
		const registry = await session.dataStores.open("registry");
		const entityTypesRepo = new EntityTypesRepository(registry);
		const openersRepo = new OpenersRepository(registry);
		const intentsRepo = new IntentsRepository(registry);
		const appsRepo = new AppsRepository(registry);
		const store = await session.dashboardStore();
		return buildDefaultsCatalog({
			entityTypes: entityTypesRepo.listAll().map((t) => t.id),
			capableApps: (entityType) => {
				const fromOpeners = openersRepo
					.listForTarget(OpenerTargetKind.EntityType, entityType)
					.map((o) => o.appId);
				const fromIntents = intentsRepo
					.findHandlers({ verb: DEFAULT_HANDLER_VERB, entityType })
					.map((h) => h.appId);
				return [...fromOpeners, ...fromIntents];
			},
			appLabel: (appId) => resolveAppName(appsRepo, appId),
			genericEditorAppId: GENERIC_OBJECT_EDITOR_APP_ID,
			currentDefaults: store.snapshot().defaultHandlers,
			// OpenRes-1c slice 2 — scheme + extension catalog sections. Each
			// distinct registered scheme / extension becomes one user-pinnable
			// row alongside the entity-type rows. The OS-handoff sentinel is
			// injected by the builder, not by the IPC handler.
			schemes: openersRepo.listDistinctTargets(OpenerTargetKind.Scheme),
			extensions: openersRepo.listDistinctTargets(OpenerTargetKind.Extension),
			capableAppsForScheme: (scheme) =>
				openersRepo.listForTarget(OpenerTargetKind.Scheme, scheme).map((o) => o.appId),
			capableAppsForExtension: (extension) =>
				openersRepo.listForTarget(OpenerTargetKind.Extension, extension).map((o) => o.appId),
		});
	});

	ipcMain.handle(
		"dashboard:upsert-widget",
		async (_event, id: string, record: WidgetRecord): Promise<void> => {
			const session = getActiveVaultSession();
			if (!session) return;
			const store = await session.dashboardStore();
			store.upsertWidget(id, record);
		},
	);

	ipcMain.handle(
		"dashboard:set-last-seen-changelog-version",
		async (_event, version: string | null): Promise<void> => {
			const session = getActiveVaultSession();
			if (!session) return;
			const store = await session.dashboardStore();
			await ensureSubscribed(store, getDashboard);
			const normalized = typeof version === "string" && version.length > 0 ? version : null;
			store.setLastSeenChangelogVersion(normalized);
		},
	);

	ipcMain.handle("dashboard:remove-widget", async (_event, id: string): Promise<void> => {
		const session = getActiveVaultSession();
		if (!session) return;
		const store = await session.dashboardStore();
		store.removeWidget(id);
	});

	// Stage 7.3 — the add-widget picker's catalog: every widget registered by an
	// installed app (the `widgets` registry table, populated at install from the
	// manifest's `registrations.widgets`), tagged with its app's display name.
	ipcMain.handle("dashboard:registered-widgets", async (): Promise<RegisteredWidget[]> => {
		const session = getActiveVaultSession();
		if (!session) return [];
		let registry: Awaited<ReturnType<typeof session.dataStores.open>>;
		try {
			registry = await session.dataStores.open("registry");
		} catch (error) {
			console.warn(`[dashboard:registered-widgets] registry unavailable: ${(error as Error).message}`);
			return [];
		}
		const appsRepo = new AppsRepository(registry);
		const widgetsRepo = new WidgetsRepository(registry);
		const out: RegisteredWidget[] = [];
		for (const app of appsRepo.listActive()) {
			const appName = resolveAppName(appsRepo, app.id);
			for (const widget of widgetsRepo.listForApp(app.id)) {
				out.push({
					appId: app.id,
					appName,
					widgetId: widget.id,
					name: widget.name,
					size: widget.size,
				});
			}
		}
		return out;
	});

	ipcMain.handle(
		"dashboard:list-wallpapers",
		async (): Promise<{ url: string; thumbUrl: string }[]> => {
			const session = getActiveVaultSession();
			if (!session) return [];
			const dir = join(session.vaultPath, "dashboard", "wallpapers");
			try {
				const entries = await readdir(dir, { withFileTypes: true });
				const originals = entries
					.filter((e) => e.isFile() && !isThumbnail(e.name))
					.sort((a, b) => a.name.localeCompare(b.name));
				// Backfill thumbnails for any originals uploaded before the
				// thumbnail pipeline existed — fire-and-forget per file so the
				// list doesn't block waiting for them.
				await Promise.all(
					originals.map(async (entry) => {
						const thumbPath = join(dir, thumbnailName(entry.name));
						const has = await stat(thumbPath).then(
							(s) => s.isFile(),
							() => false,
						);
						if (has) return;
						const raw = await readFile(join(dir, entry.name)).catch(() => null);
						if (!raw) return;
						// A migrated original is sealed — decrypt before thumbnailing.
						const plain = isSealedMedia(raw)
							? Buffer.from(session.openMedia(VaultMediaDomain.Wallpaper, entry.name, raw))
							: raw;
						await ensureThumbnail(dir, entry.name, plain, wallpaperSeal(session));
					}),
				);
				return originals.map((e) => ({
					url: `brainstorm://wallpaper/${encodeURIComponent(e.name)}`,
					thumbUrl: `brainstorm://wallpaper/${encodeURIComponent(thumbnailName(e.name))}`,
				}));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
				console.warn("[brainstorm] dashboard:list-wallpapers failed:", error);
				return [];
			}
		},
	);

	ipcMain.handle("dashboard:delete-wallpaper", async (_event, url: string): Promise<boolean> => {
		const session = getActiveVaultSession();
		if (!session) return false;
		const match = url.match(/^brainstorm:\/\/wallpaper\/(.+)$/);
		if (!match) return false;
		const fileName = decodeURIComponent(match[1] ?? "");
		if (!fileName || fileName.includes("..") || fileName.includes("/")) return false;
		const baseDir = join(session.vaultPath, "dashboard", "wallpapers");
		const target = join(baseDir, fileName);
		const thumbTarget = join(baseDir, thumbnailName(fileName));
		try {
			await unlink(target);
			await unlink(thumbTarget).catch(() => undefined); // best-effort
			return true;
		} catch (error) {
			console.warn("[brainstorm] dashboard:delete-wallpaper failed:", error);
			return false;
		}
	});

	ipcMain.handle(
		"dashboard:upload-wallpaper",
		async (event): Promise<{ url: string; thumbUrl: string } | null> => {
			const session = getActiveVaultSession();
			if (!session) {
				console.warn("[brainstorm] dashboard:upload-wallpaper: no active vault session");
				return null;
			}
			try {
				const parent = getDashboard();
				const dialogOptions = {
					title: "Choose wallpaper image",
					properties: ["openFile" as const],
					filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "avif"] }],
				};
				const result =
					parent && !parent.isDestroyed()
						? await dialog.showOpenDialog(parent, dialogOptions)
						: await dialog.showOpenDialog(dialogOptions);
				void event;
				if (result.canceled || result.filePaths.length === 0) return null;
				const sourcePath = result.filePaths[0];
				if (!sourcePath) return null;
				const dir = join(session.vaultPath, "dashboard", "wallpapers");
				await mkdir(dir, { recursive: true });
				// Content-addressable: the file's sha256 IS its name. Re-uploading
				// the same image is a no-op (existing file is reused).
				const bytes = await readFile(sourcePath);
				const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
				const ext = extname(sourcePath).toLowerCase() || ".png";
				const fileName = `${hash}${ext}`;
				const dest = join(dir, fileName);
				const exists = await stat(dest).then(
					(s) => s.isFile(),
					() => false,
				);
				// Encrypt the original at rest (OQ-240) — write sealed bytes rather
				// than copying the plaintext source in.
				if (!exists) {
					await writeFile(dest, session.sealMedia(VaultMediaDomain.Wallpaper, fileName, bytes));
				}
				// Generate a 320×180 JPEG thumbnail for the settings gallery so
				// the panel doesn't drag mid-animation under a stack of
				// multi-MB originals.
				await ensureThumbnail(dir, fileName, bytes, wallpaperSeal(session));
				return {
					url: `brainstorm://wallpaper/${encodeURIComponent(fileName)}`,
					thumbUrl: `brainstorm://wallpaper/${encodeURIComponent(thumbnailName(fileName))}`,
				};
			} catch (error) {
				console.error("[brainstorm] dashboard:upload-wallpaper failed:", error);
				return null;
			}
		},
	);
}

const THUMB_SUFFIX = ".thumb.jpg";
const THUMB_WIDTH = 320;
const THUMB_JPEG_QUALITY = 78;

function thumbnailName(originalName: string): string {
	return `${originalName}${THUMB_SUFFIX}`;
}

/** Build the Wallpaper-domain at-rest seal from the active session (OQ-240). */
function wallpaperSeal(session: {
	sealMedia(domain: VaultMediaDomain, relName: string, bytes: Uint8Array): Uint8Array;
}): MediaSeal {
	return (relName, bytes) => session.sealMedia(VaultMediaDomain.Wallpaper, relName, bytes);
}

function isThumbnail(name: string): boolean {
	return name.endsWith(THUMB_SUFFIX);
}

/** Generate a 320px-wide thumbnail next to the original. Idempotent — bails
 *  early if the thumbnail already exists (content-addressable hash means a
 *  matching original implies a matching thumbnail). Exported so the new-vault
 *  seed can mint the default wallpaper's thumbnail too (otherwise the dashboard
 *  requests a `.thumb.jpg` that never existed and logs a 404 every boot — F-246).
 *  `seal` encrypts the thumbnail at rest (OQ-240); the seed omits it (plaintext,
 *  re-sealed by the open-time migration). */
export async function ensureThumbnail(
	dir: string,
	fileName: string,
	bytes: Buffer,
	seal: MediaSeal = (_relName, b) => b,
): Promise<void> {
	const thumbName = thumbnailName(fileName);
	const thumbPath = join(dir, thumbName);
	const already = await stat(thumbPath).then(
		(s) => s.isFile(),
		() => false,
	);
	if (already) return;
	try {
		const img = nativeImage.createFromBuffer(bytes);
		if (img.isEmpty()) {
			console.warn(`[brainstorm] thumbnail: nativeImage couldn't decode ${fileName}`);
			return;
		}
		const size = img.getSize();
		const targetWidth = Math.min(THUMB_WIDTH, size.width);
		const resized = img.resize({ width: targetWidth, quality: "good" });
		const jpeg = resized.toJPEG(THUMB_JPEG_QUALITY);
		await writeFile(thumbPath, seal(thumbName, jpeg));
	} catch (error) {
		console.warn(`[brainstorm] thumbnail generation failed for ${fileName}:`, error);
	}
}

let nativeThemeListener: (() => void) | null = null;

/** Mirror the unread notification count onto the OS app badge (macOS dock /
 *  Linux launcher; a no-op elsewhere). Diffed so unrelated store mutations
 *  don't re-touch the dock. */
let lastBadgeCount = -1;

function updateNotificationBadge(store: DashboardStore): void {
	const unread = store.snapshot().notificationHistory.filter((n) => !n.read).length;
	if (unread === lastBadgeCount) return;
	lastBadgeCount = unread;
	try {
		app.setBadgeCount(unread);
	} catch {
		// `app` isn't available in test contexts.
	}
}

async function ensureSubscribed(
	store: DashboardStore,
	getDashboard: DashboardTargetGetter,
): Promise<void> {
	// Re-subscribe whenever the store identity changes (vault switch, dev
	// reload, etc.) so we never leak a subscription to an orphaned store.
	if (subscribedStore === store) return;
	if (unsubscribe) unsubscribe();
	if (nativeThemeListener) {
		try {
			nativeTheme.off("updated", nativeThemeListener);
		} catch {
			// nativeTheme isn't available in test contexts.
		}
		nativeThemeListener = null;
	}
	subscribedStore = store;
	lastBroadcastTheme = resolveEffectiveSnapshotTheme(store);
	lastBroadcastLanguage = store.snapshot().locale.language;
	lastBroadcastFormat = regionalToFormatContext(
		store.snapshot().locale.language,
		store.snapshot().regional,
	);

	const pushSnapshot = (): void => {
		const target = getDashboard();
		const session = getActiveVaultSession();
		const effectiveTheme = resolveEffectiveSnapshotTheme(store);
		updateNotificationBadge(store);
		if (target && !target.isDestroyed()) {
			// Claim the sequence synchronously (in push order) so a later, slower
			// enrichment can't overwrite an earlier-claimed-but-newer one.
			const seq = snapshotSequencer.claim();
			if (session) {
				void enrichSnapshot(session, store)
					.then((enriched) => {
						if (!target.isDestroyed() && snapshotSequencer.shouldSend(seq)) {
							target.webContents.send(DASHBOARD_SNAPSHOT_CHANNEL, enriched);
						}
					})
					.catch((error) => {
						console.warn("[brainstorm] dashboard snapshot enrich failed:", error);
						if (!target.isDestroyed() && snapshotSequencer.shouldSend(seq)) {
							const fallback = store.snapshot(
								effectiveSlotFor(store.snapshot().appearance.mode, osPrefersDark()),
							);
							target.webContents.send(DASHBOARD_SNAPSHOT_CHANNEL, { ...fallback, pins: {} });
						}
					});
			} else if (snapshotSequencer.shouldSend(seq)) {
				const fallback = store.snapshot(
					effectiveSlotFor(store.snapshot().appearance.mode, osPrefersDark()),
				);
				target.webContents.send(DASHBOARD_SNAPSHOT_CHANNEL, { ...fallback, pins: {} });
			}
		}
		// Broadcast theme-driven token swap to every window. Diff on the
		// effective theme so unrelated dashboard mutations (icons, widgets,
		// wallpaper in the inactive slot) don't trigger redundant re-styles.
		if (effectiveTheme !== lastBroadcastTheme) {
			lastBroadcastTheme = effectiveTheme;
			broadcastTokens(effectiveTheme, getDashboard);
		}
		// Broadcast the active UI locale to every app window. Diff on the
		// language so unrelated dashboard mutations don't re-notify apps (12.15).
		const language = store.snapshot().locale.language;
		if (language !== lastBroadcastLanguage) {
			lastBroadcastLanguage = language;
			broadcastLocaleToWindows(language, getAppWindowsRef?.() ?? []);
		}
		// Broadcast the regional-format context to every app window. Diff
		// structurally so only a real Regional / language change re-notifies
		// apps (12.15 slice 15f).
		const format = regionalToFormatContext(language, store.snapshot().regional);
		if (!lastBroadcastFormat || !sameFormatContext(format, lastBroadcastFormat)) {
			lastBroadcastFormat = format;
			broadcastFormatToWindows(format, getAppWindowsRef?.() ?? []);
		}
		// Stage 7.3 — reconcile the dashboard's native widget surfaces against the
		// placed-widget set on every snapshot (also fires immediately on subscribe,
		// so a vault open recreates persisted widgets). The controller no-ops when
		// the set is unchanged.
		widgetSnapshotHook?.({
			widgets: store.snapshot().widgets,
			theme: effectiveTheme,
			locale: language,
			format,
		});
	};

	unsubscribe = store.subscribe(() => pushSnapshot());
	// Badge from the freshly-subscribed store right away (vault open/switch) —
	// the subscription only fires on subsequent mutations.
	updateNotificationBadge(store);

	// In Auto mode the OS preference drives the effective slot — hook
	// `nativeTheme.updated` so a system dark/light flip re-pushes the
	// snapshot (and re-broadcasts the theme to app windows) without the
	// user touching anything.
	try {
		nativeThemeListener = () => pushSnapshot();
		nativeTheme.on("updated", nativeThemeListener);
	} catch {
		// Test environment; the renderer matchMedia path will still drive
		// the dashboard repaint, but app-window broadcasts won't fire here.
	}
}

function resolveEffectiveSnapshotTheme(store: DashboardStore): ThemeName {
	const appearance = store.snapshot().appearance;
	const slot = effectiveSlotFor(appearance.mode, osPrefersDark());
	return slot === AppearanceSlot.Dark ? appearance.dark.theme : appearance.light.theme;
}

function broadcastTokens(theme: ThemeName, getDashboard: DashboardTargetGetter): void {
	broadcastThemeToWindows(theme, getDashboard(), getAppWindowsRef?.() ?? []);
}

/** Pure helper — paint the theme into every live window. Exported for the
 *  regression test: theme changes have to reach every sandboxed app
 *  renderer or the design system silently splits between shell and apps
 *  (the failure mode the user hit in 9.13.1.9). */
export function broadcastThemeToWindows(
	theme: ThemeName,
	dashboard: BrowserWindow | null,
	appWindows: readonly AppWindow[],
): void {
	const backgroundColor = themes[theme].color.background.primary;

	if (dashboard && !dashboard.isDestroyed()) {
		try {
			dashboard.setBackgroundColor(backgroundColor);
			// The dashboard renderer resolves its theme from the entity-pin-enriched
			// `dashboard:snapshot`, which awaits a DB read on a pinned dashboard — so
			// the shell lagged the apps (which get this synchronous signal) on a
			// light/dark toggle. Push the resolved name here too so ThemeProvider
			// repaints in lockstep; the snapshot re-applies the same value idempotently.
			dashboard.webContents.send(APP_THEME_CHANGED_CHANNEL, theme);
		} catch (error) {
			console.warn("[brainstorm] dashboard theme broadcast failed:", error);
		}
	}

	const seenContainers = new Set<number>();
	for (const win of appWindows) {
		if (!isAppWindowLive(win)) continue;
		try {
			// `setBackgroundColor` is window-level — apply once per container, not
			// per tab. The theme signal goes to every tab renderer.
			const base = win.container.baseWindow;
			if (!seenContainers.has(base.id) && !base.isDestroyed()) {
				seenContainers.add(base.id);
				base.setBackgroundColor(backgroundColor);
				// The tab strip is a separate WebContentsView per container — it
				// doesn't receive the per-tab `app:theme-changed` broadcast, so push
				// the name to it once per container or it stays on the boot theme.
				win.container.pushChromeTheme(theme);
			}
			win.webContents.send(APP_THEME_CHANGED_CHANNEL, theme);
		} catch (error) {
			console.warn(`[brainstorm] theme broadcast to ${win.appId} failed:`, error);
		}
	}
}

/** Pure helper — push the active UI locale to every live app window. Mirrors
 *  `broadcastThemeToWindows`' window walk; locale carries no background colour,
 *  so it only sends the per-tab `app:locale-changed` signal (the dashboard
 *  renderer follows its own synced `locale` map via `LocaleGate`). Exported for
 *  the regression test — locale changes have to reach every sandboxed app
 *  renderer or the language switch silently splits between shell and apps. */
export function broadcastLocaleToWindows(locale: string, appWindows: readonly AppWindow[]): void {
	for (const win of appWindows) {
		if (!isAppWindowLive(win)) continue;
		try {
			win.webContents.send(APP_LOCALE_CHANGED_CHANNEL, locale);
		} catch (error) {
			console.warn(`[brainstorm] locale broadcast to ${win.appId} failed:`, error);
		}
	}
}

/** Pure helper — push the active regional-format context to every live app
 *  window (12.15 slice 15f). Sibling of `broadcastLocaleToWindows`; exported for
 *  the regression test so a Regional change is proven to reach every sandboxed
 *  app renderer. */
export function broadcastFormatToWindows(
	format: FormatContext,
	appWindows: readonly AppWindow[],
): void {
	for (const win of appWindows) {
		if (!isAppWindowLive(win)) continue;
		try {
			win.webContents.send(APP_FORMAT_CHANGED_CHANNEL, format);
		} catch (error) {
			console.warn(`[brainstorm] format broadcast to ${win.appId} failed:`, error);
		}
	}
}

/** Fan a transient theme-preview payload (or `null` to revert) out to the
 *  dashboard + every app window. Mirrors `broadcastThemeToWindows`' window
 *  walk; preview never touches `setBackgroundColor` (it's transient + reverts,
 *  so the committed window background stays authoritative). */
export function broadcastThemePreviewToWindows(
	payload: ThemePreviewPayload | null,
	dashboard: BrowserWindow | null,
	appWindows: readonly AppWindow[],
): void {
	if (dashboard && !dashboard.isDestroyed()) {
		try {
			dashboard.webContents.send(APP_THEME_PREVIEW_CHANNEL, payload);
		} catch (error) {
			console.warn("[brainstorm] dashboard theme-preview failed:", error);
		}
	}
	for (const win of appWindows) {
		if (!isAppWindowLive(win)) continue;
		try {
			win.webContents.send(APP_THEME_PREVIEW_CHANNEL, payload);
		} catch (error) {
			console.warn(`[brainstorm] theme-preview to ${win.appId} failed:`, error);
		}
	}
}

/** Drop the snapshot subscription — called when the dashboard window closes. */
export function disposeDashboardHandlers(): void {
	if (unsubscribe) {
		unsubscribe();
		unsubscribe = null;
	}
	if (nativeThemeListener) {
		try {
			nativeTheme.off("updated", nativeThemeListener);
		} catch {
			// nativeTheme isn't available in test contexts.
		}
		nativeThemeListener = null;
	}
}
