/**
 * `properties:*` IPC handlers — let the dashboard renderer read + mutate
 * the shell-owned vault-level property + dictionary catalog directly.
 *
 * The dashboard is a shell-trusted surface, so it talks to the
 * `PropertiesStore` over dedicated `ipcMain.handle` channels — not via
 * the broker. This mirrors how `dashboard-handlers.ts` handles the
 * Dashboard/Wallpaper/Theme surfaces. App renderers (Notes, Database,
 * Graph) use the SDK proxy from VP-3 (broker → `PropertiesService`)
 * instead; both paths converge on the same `PropertiesStore`.
 *
 * Subscribe-side: a `properties:snapshot` push channel re-broadcasts
 * the store's full snapshot to the dashboard window on every commit,
 * so the Settings → Data tab live-updates without polling. Same shape
 * as `dashboard:snapshot`. Re-subscribes automatically when the store
 * identity changes (vault switch).
 */

import type { Dictionary, PropertyDef } from "@brainstorm-os/sdk-types";
import { type BrowserWindow, ipcMain } from "electron";
import { type AppWindow, isAppWindowLive } from "../apps/launcher";
import type { PropertiesStore } from "../properties/properties-store";
import { EMPTY_USAGE_COUNTS, type UsageCounts, type UsageIndex } from "../properties/usage-index";
import { EntityTypesRepository } from "../storage/registry-repo/entity-types-repo";
import { getActiveVaultSession } from "../vault/session";

/** Broadcast snapshot — the store's properties + dictionaries enriched
 *  with the latest lazy usage counts. The store-level
 *  `PropertiesSnapshot` (in `properties-store.ts`) intentionally stays
 *  usage-free so the broker `properties.list()` proxy serves apps the
 *  same shape it always has; the usage counts are a privileged-renderer
 *  affordance and live only on this `properties:snapshot` channel. */
export type PropertiesBroadcastSnapshot = {
	properties: Record<string, PropertyDef>;
	dictionaries: Record<string, Dictionary>;
	usage: UsageCounts;
};

export const PROPERTIES_SNAPSHOT_CHANNEL = "properties:snapshot";
/** App-renderer-bound staleness signal. Apps respond by calling
 *  `properties.list()` over the broker to pull the fresh snapshot
 *  (re-running the capability check). Payload-free on purpose — the
 *  authoritative snapshot must always flow through the broker. */
export const APP_PROPERTIES_CHANGED_CHANNEL = "app:properties-changed";

type DashboardTargetGetter = () => BrowserWindow | null;
type AppWindowsGetter = () => readonly AppWindow[];
type UsageIndexGetter = () => UsageIndex | null;

let subscribedStore: PropertiesStore | null = null;
let unsubscribe: (() => void) | null = null;
let getAppWindowsRef: AppWindowsGetter | null = null;
let getUsageIndexRef: UsageIndexGetter | null = null;
let getDashboardRef: DashboardTargetGetter | null = null;

export function registerPropertiesHandlers(
	getDashboard: DashboardTargetGetter,
	options: {
		getAppWindows?: AppWindowsGetter;
		getUsageIndex?: UsageIndexGetter;
	} = {},
): void {
	getAppWindowsRef = options.getAppWindows ?? null;
	getUsageIndexRef = options.getUsageIndex ?? null;
	getDashboardRef = getDashboard;
	ipcMain.handle("properties:snapshot", async (): Promise<PropertiesBroadcastSnapshot | null> => {
		const store = await activeStore();
		if (!store) return null;
		await ensureSubscribed(store, getDashboard);
		return composeBroadcast(store);
	});

	// The registered entity types, so the Settings property editor can scope a
	// Relation (`entityRef`) to specific types via `allowedTypes`. Registry-db
	// read only; no mutation. Empty when no vault session is active.
	ipcMain.handle("properties:entity-types", async (): Promise<string[]> => {
		const session = getActiveVaultSession();
		if (!session) return [];
		const registry = await session.dataStores.open("registry");
		return new EntityTypesRepository(registry).listAll().map((row) => row.id);
	});

	ipcMain.handle("properties:set-property", async (_event, def: PropertyDef): Promise<void> => {
		const store = await activeStore();
		if (!store) return;
		await ensureSubscribed(store, getDashboard);
		store.setProperty(def);
	});

	ipcMain.handle("properties:remove-property", async (_event, key: string): Promise<void> => {
		const store = await activeStore();
		if (!store) return;
		await ensureSubscribed(store, getDashboard);
		store.removeProperty(key);
	});

	ipcMain.handle("properties:set-dictionary", async (_event, dict: Dictionary): Promise<void> => {
		const store = await activeStore();
		if (!store) return;
		await ensureSubscribed(store, getDashboard);
		store.setDictionary(dict);
	});

	ipcMain.handle("properties:remove-dictionary", async (_event, id: string): Promise<void> => {
		const store = await activeStore();
		if (!store) return;
		await ensureSubscribed(store, getDashboard);
		store.removeDictionary(id);
	});
}

/** Subscribe immediately to an already-open PropertiesStore so app
 *  windows receive change signals even without any dashboard read-path
 *  call having warmed up the listener first. Called by `main/index.ts`
 *  after each vault session activates. Safe to call repeatedly — the
 *  ensure-subscribed guard deduplicates. */
export async function ensurePropertiesBroadcast(
	getDashboard: DashboardTargetGetter,
): Promise<void> {
	const store = await activeStore();
	if (!store) return;
	await ensureSubscribed(store, getDashboard);
}

async function activeStore(): Promise<PropertiesStore | null> {
	const session = getActiveVaultSession();
	if (!session) return null;
	return await session.propertiesStore();
}

async function ensureSubscribed(
	store: PropertiesStore,
	getDashboard: DashboardTargetGetter,
): Promise<void> {
	// Re-subscribe whenever the store identity changes (vault switch, dev
	// reload, etc.) so we never leak a subscription to an orphaned store.
	if (subscribedStore === store) return;
	if (unsubscribe) unsubscribe();
	subscribedStore = store;
	unsubscribe = store.subscribe(() => {
		// Properties / dictionaries changed → re-derive both halves of the
		// snapshot. Usage references may have flipped (a deleted property
		// becomes a zero entry, a new vocabulary item becomes addressable),
		// so it has to be a fresh compose, not a cached one.
		const idx = getUsageIndexRef?.() ?? null;
		idx?.invalidate();
		void republishToDashboard(store, getDashboard);
		broadcastStaleSignalToApps();
	});
}

/** Compose the broadcast snapshot — properties + dictionaries from the
 *  store, plus the latest usage counts. The usage half resolves to the
 *  empty snapshot when the index isn't wired (Bun-only tests, dashboard-
 *  less smoke harnesses) so consumers never see `undefined`. */
async function composeBroadcast(store: PropertiesStore): Promise<PropertiesBroadcastSnapshot> {
	const base = store.snapshot();
	const idx = getUsageIndexRef?.() ?? null;
	const usage = idx ? await idx.snapshot() : EMPTY_USAGE_COUNTS;
	return { properties: base.properties, dictionaries: base.dictionaries, usage };
}

async function republishToDashboard(
	store: PropertiesStore,
	getDashboard: DashboardTargetGetter,
): Promise<void> {
	const snap = await composeBroadcast(store);
	const target = getDashboard();
	if (target && !target.isDestroyed()) {
		target.webContents.send(PROPERTIES_SNAPSHOT_CHANNEL, snap);
	}
}

/** Called by the vault-entities broadcasters whenever entity state
 *  changes (storage envelope, entities-service mutation, Bin restore /
 *  purge). Invalidates the usage cache + repushes the composed snapshot
 *  so the Settings → Data pane's usage pills update without polling.
 *  Drops the broadcast quietly when there is no active subscription
 *  (no vault session, dashboard window closed). */
export async function republishPropertiesSnapshot(): Promise<void> {
	if (!subscribedStore || !getDashboardRef) return;
	const idx = getUsageIndexRef?.() ?? null;
	idx?.invalidate();
	await republishToDashboard(subscribedStore, getDashboardRef);
}

function broadcastStaleSignalToApps(): void {
	broadcastStaleSignalToAppWindows(getAppWindowsRef?.() ?? []);
}

/** Pure helper — push `app:properties-changed` to every live app
 *  window in `appWindows`. Exported for tests so the broadcast can be
 *  exercised without spinning up a vault session + IPC. */
export function broadcastStaleSignalToAppWindows(appWindows: readonly AppWindow[]): void {
	for (const win of appWindows) {
		if (!isAppWindowLive(win)) continue;
		try {
			win.webContents.send(APP_PROPERTIES_CHANGED_CHANNEL);
		} catch (error) {
			console.warn(`[brainstorm] properties stale-signal to ${win.appId} failed:`, error);
		}
	}
}

/** Drop the snapshot subscription — called when the dashboard window
 *  closes. Mirrors `disposeDashboardHandlers` from dashboard-handlers. */
export function disposePropertiesHandlers(): void {
	if (unsubscribe) {
		unsubscribe();
		unsubscribe = null;
	}
	subscribedStore = null;
	getUsageIndexRef = null;
	getDashboardRef = null;
}
