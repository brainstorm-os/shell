/**
 * AppLauncher — manages the OS windows that host installed apps. Each top-level
 * window is a `WindowContainer` (an Electron `BaseWindow`) holding one or more
 * tabs; each tab is a sandboxed app renderer (`WebContentsView`) with the
 * app-specific preload that stamps the app's identity.
 *
 * Per §Launch,
 * §Isolation, and +37 (shell-owned tabs):
 *
 *   - Tabs are intra-app (v1) — every tab in a container is the same app.
 *   - Each tab's renderer has its own `webContents.id`, registered in the
 *     renderer-identity registry, so the broker scopes capabilities per tab.
 *  - Sandbox on; nodeIntegration off; contextIsolation on. Per
 *   - The preload reads the app id + per-tab handshake from `additionalArguments`
 *     and stamps it into every envelope before app JS runs.
 *
 * The launcher keys containers by `${appId}::${windowId}` (windowId defaults to
 * "main"); `windowId` is the *container* identity, not a tab. Closing the OS
 * window PARKS the whole container (hidden-but-alive, warm-kept); the LRU caps
 * how many parked containers stay resident.
 */

import { join } from "node:path";
import { encodeHandshake } from "@brainstorm-os/sdk";
import type { AppHandshake, FormatContext, LaunchContext } from "@brainstorm-os/sdk-types";
import { type ThemeName, themes } from "@brainstorm-os/tokens";
import { entityRoute, routesEquivalent } from "../../shared/route";
import type { RendererIdentityRegistry } from "../ipc/renderer-identity";
import type { AppsRepository } from "../storage/registry-repo";
import { focusStealingDisabled, revealWindow } from "../window/reveal-window";
import {
	type BaseWindowHandle,
	type Tab,
	type TabViewFactory,
	WindowContainer,
} from "./window-container";

export type LaunchOptions = {
	appId: string;
	/** Where to load the app from. The path comes from the apps repo's
	 *  `bundle_dir` column — never user-supplied. */
	bundleDir: string;
	/** Relative path inside `bundleDir` to the renderer entry HTML. Comes
	 *  from `manifest.entry`. Validated by `LaunchOrchestrator` against
	 *  path-traversal before reaching here. */
	entryPath: string;
	/** Initial launch context surfaced to the app via the handshake. */
	launch: LaunchContext;
	/** The full capability set the app currently holds. */
	capabilities: readonly string[];
	/** App's manifest version + sdk for the handshake. */
	version: string;
	sdk: string;
	/** Optional named container id for multi-window apps (defaults to "main"). */
	windowId?: string;
	/** Active shell theme name. Passed to the app preload via
	 *  `--brainstorm-theme=<name>`. */
	theme?: ThemeName;
	/** Active UI locale (BCP-47 tag). Rides the handshake so a freshly-launched
	 *  window renders its first frame in the right language (12.15). */
	locale?: string;
	/** Active regional-format context. Rides the handshake so a freshly-launched
	 *  window formats dates / numbers per Settings → Regional (12.15 15f). */
	format?: FormatContext;
};

/** Public per-tab record consumed by the window index, intents bus, and the
 *  main-process broadcasters. One per open tab; `windowId` is the container it
 *  lives in. Snapshots are minted on demand from live containers. */
export type AppWindow = {
	appId: string;
	windowId: string;
	tabId: string;
	webContentsId: number;
	/** The tab renderer — broadcasters `.send()` to this. */
	webContents: Tab["view"]["webContents"];
	/** The OS window this tab lives in — window-level ops go here. */
	container: WindowContainer;
	/** Warm-keep state of the container (a parked container reads as closed). */
	parked: boolean;
};

/** True when `win` can still receive a `.send()`. A tab closing concurrently
 *  with a broadcast leaves an AppWindow whose `webContents` Electron has already
 *  nulled (the type says non-optional, but teardown races make it nullish at
 *  runtime) — so broadcasters MUST deref-guard before calling `isDestroyed()`,
 *  or an in-flight entity write rejects with "reading 'isDestroyed' of
 *  undefined". This is the one sanctioned guard; every window broadcaster uses
 *  it instead of an inline `win.webContents.isDestroyed()`. */
export function isAppWindowLive(win: AppWindow): boolean {
	return Boolean(win.webContents) && !win.webContents.isDestroyed();
}

/** Creates the OS window (`BaseWindow`) for a container. Injected so tests can
 *  swap a fake; production builds a real `BaseWindow` in `launch-setup.ts`. */
export type ContainerFactory = (spec: {
	appId: string;
	windowId: string;
	title: string;
	backgroundColor: string;
}) => BaseWindowHandle;

/** Creates the shell chrome (tab strip) view for a container. Loads the
 *  tab-strip renderer with the chrome preload. Optional — when absent, the
 *  container runs strip-less (Stage-1 behavior). */
export type ChromeViewFactory = (spec: {
	appId: string;
	theme?: ThemeName;
}) => import("./window-container").WebContentsViewHandle;

/** Height of the shell-drawn tab strip in DIP. 28px tab + 2×`--space-2`
 *  (8px) vertical padding = 44. */
export const STRIP_HEIGHT_PX = 44;

/** How many recently-closed containers to keep warm (parked) at once. */
export const DEFAULT_MAX_PARKED_WINDOWS = 3;

function envMaxParkedWindows(): number | undefined {
	const raw = process.env.BRAINSTORM_MAX_PARKED_WINDOWS;
	if (!raw) return undefined;
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : undefined;
}

export type AppLauncherOptions = {
	mainDir: string;
	appsRepo: AppsRepository;
	identities: RendererIdentityRegistry;
	containerFactory: ContainerFactory;
	tabViewFactory: TabViewFactory;
	/** Builds the shell tab strip. Omit to run strip-less (tests / Stage 1). */
	chromeViewFactory?: ChromeViewFactory;
	/** Resolve an app's display name for the placeholder tab/window title (the
	 *  app overrides it via `document.title` once the object loads). */
	resolveAppName?: (appId: string) => string;
	/** Override the warm-keep cap (tests use a small value). */
	maxParkedWindows?: number;
	/** Reveal + focus the dashboard window. Called when the last visible app
	 *  window goes away (park or teardown) — without it, focus has nowhere to
	 *  land: on macOS a fullscreen/Spaces setup is left staring at an empty
	 *  Space (black screen) because the hidden dashboard never takes over by
	 *  itself. */
	revealDashboard?: () => void;
};

type ContainerRecord = {
	key: string;
	appId: string;
	windowId: string;
	container: WindowContainer;
	parked: boolean;
	chromeWcId: number | null;
};

export class AppLauncher {
	private readonly containers = new Map<string, ContainerRecord>(); // key: `${appId}::${windowId}`
	private readonly recordByContainerId = new Map<string, ContainerRecord>();
	private readonly tabIndex = new Map<number, { record: ContainerRecord; tabId: string }>();
	private readonly chromeIndex = new Map<number, ContainerRecord>();
	private readonly listeners = new Set<() => void>();
	private readonly parkedOrder: string[] = [];
	private readonly evicting = new Set<string>();
	private quitting = false;
	private tabSeq = 0;
	private windowSeq = 0;
	private readonly maxParkedWindows: number;

	constructor(private readonly options: AppLauncherOptions) {
		this.maxParkedWindows =
			options.maxParkedWindows ?? envMaxParkedWindows() ?? DEFAULT_MAX_PARKED_WINDOWS;
	}

	prepareForQuit(): void {
		this.quitting = true;
	}

	runningAppIds(): string[] {
		const out = new Set<string>();
		for (const record of this.containers.values()) {
			if (record.parked) continue;
			out.add(record.appId);
		}
		return [...out];
	}

	onWindowsChanged(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private notifyWindowsChanged(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch (error) {
				console.warn("[AppLauncher] listener threw:", error);
			}
		}
	}

	/** Launch (or focus) a container for the given app, opening the launch
	 *  context as its first/active tab. Reuses an existing container for the
	 *  same `(appId, windowId)`; a parked one is un-parked. */
	launch(opts: LaunchOptions): AppWindow {
		const windowId = opts.windowId ?? "main";
		const key = `${opts.appId}::${windowId}`;
		const existing = this.containers.get(key);
		if (existing && !existing.container.baseWindow.isDestroyed()) {
			if (existing.parked) this.unpark(key, existing);
			this.bringToFront(existing.container.baseWindow);
			const active = existing.container.activeTab();
			if (active) return this.snapshot(existing, active);
			return this.snapshot(existing, this.addTabFor(existing, opts));
		}

		// Validate before creating the OS window so a bad launch never leaves an
		// orphan empty container behind.
		this.resolveAppRecord(opts);
		const record = this.createContainer(opts.appId, windowId, opts.theme);
		const tab = this.addTabFor(record, opts);
		this.notifyWindowsChanged();
		return this.snapshot(record, tab);
	}

	/** Open the launch context as a NEW tab in an existing container (new-tab
	 *  mode). Falls back to a fresh container if the target is gone. */
	addTabToContainer(containerId: string, opts: LaunchOptions): AppWindow {
		const record = this.recordByContainerId.get(containerId);
		if (!record || record.container.baseWindow.isDestroyed()) return this.openInNewWindow(opts);
		if (record.parked) this.unpark(record.key, record);
		const tab = this.addTabFor(record, opts);
		this.bringToFront(record.container.baseWindow);
		this.notifyWindowsChanged();
		return this.snapshot(record, tab);
	}

	/** Open the launch context in a brand-new container (new-window mode). */
	openInNewWindow(opts: LaunchOptions): AppWindow {
		this.resolveAppRecord(opts);
		const windowId = opts.windowId ?? `win-${++this.windowSeq}`;
		const record = this.createContainer(opts.appId, windowId, opts.theme);
		const tab = this.addTabFor(record, opts);
		this.notifyWindowsChanged();
		return this.snapshot(record, tab);
	}

	/** Focus the first tab whose route is route-equivalent to `route` (the
	 *  focus-existing rung). Restores a parked container. Returns null when no
	 *  open tab shows the route. */
	focusTabByRoute(route: string): AppWindow | null {
		for (const record of this.containers.values()) {
			if (record.container.baseWindow.isDestroyed()) continue;
			for (const tab of record.container.tabs()) {
				if (!tab.route || !routesEquivalent(tab.route, route)) continue;
				if (record.parked) this.unpark(record.key, record);
				record.container.activateTab(tab.tabId);
				this.bringToFront(record.container.baseWindow);
				return this.snapshot(record, tab);
			}
		}
		return null;
	}

	/** The container id hosting a given tab renderer, or null. Lets the
	 *  navigation resolver open a new tab in the *source* window's container. */
	containerIdForWebContents(webContentsId: number): string | null {
		return this.tabIndex.get(webContentsId)?.record.container.id ?? null;
	}

	/** Activate a specific tab by its renderer's webContents id (the navigation
	 *  resolver uses this for focus-existing). Returns the focused tab snapshot. */
	focusTab(webContentsId: number): AppWindow | null {
		const hit = this.tabIndex.get(webContentsId);
		if (!hit) return null;
		const { record, tabId } = hit;
		if (record.container.baseWindow.isDestroyed()) return null;
		if (record.parked) this.unpark(record.key, record);
		record.container.activateTab(tabId);
		this.bringToFront(record.container.baseWindow);
		const tab = record.container.tabById(tabId);
		return tab ? this.snapshot(record, tab) : null;
	}

	/** Close every container belonging to an app (tears down, never parks). */
	closeApp(appId: string): void {
		let removed = false;
		for (const [key, record] of [...this.containers]) {
			if (record.appId !== appId) continue;
			this.evict(key, record);
			removed = true;
		}
		if (removed) this.notifyWindowsChanged();
	}

	/** Tear down every parked container. Called on vault lock / close / switch. */
	evictAllParked(): void {
		for (const key of [...this.parkedOrder]) {
			const record = this.containers.get(key);
			if (record) this.evict(key, record);
		}
	}

	windowsFor(appId: string): AppWindow[] {
		const out: AppWindow[] = [];
		for (const record of this.containers.values()) {
			if (record.appId !== appId) continue;
			if (record.container.baseWindow.isDestroyed()) continue;
			for (const tab of record.container.tabs()) out.push(this.snapshot(record, tab));
		}
		return out;
	}

	/** Look up the active tab of an app's container without launching. Used by
	 *  the IntentsBus to decide whether to push the intent or relaunch. */
	getExistingWindow(appId: string, windowId = "main"): AppWindow | null {
		const key = `${appId}::${windowId}`;
		const record = this.containers.get(key);
		if (!record || record.container.baseWindow.isDestroyed()) return null;
		const active = record.container.activeTab();
		return active ? this.snapshot(record, active) : null;
	}

	/** Every live tab across every container. Broadcasters push to each. */
	allWindows(): AppWindow[] {
		const out: AppWindow[] = [];
		for (const record of this.containers.values()) {
			if (record.container.baseWindow.isDestroyed()) continue;
			for (const tab of record.container.tabs()) out.push(this.snapshot(record, tab));
		}
		return out;
	}

	/** Every live container (one per OS window). Used for window-level ops
	 *  (lock/hide, the window index). */
	allContainers(): {
		container: WindowContainer;
		appId: string;
		windowId: string;
		parked: boolean;
	}[] {
		const out = [];
		for (const record of this.containers.values()) {
			if (record.container.baseWindow.isDestroyed()) continue;
			out.push({
				container: record.container,
				appId: record.appId,
				windowId: record.windowId,
				parked: record.parked,
			});
		}
		return out;
	}

	/** Resolve the container a tab-strip chrome view belongs to, from its
	 *  webContents id. Used by the chrome-tabs IPC handlers so a strip can only
	 *  drive its own container. Returns null for any other sender. */
	containerForChromeSender(
		webContentsId: number,
	): { container: WindowContainer; appId: string; windowId: string } | null {
		const record = this.chromeIndex.get(webContentsId);
		if (!record || record.container.baseWindow.isDestroyed()) return null;
		return { container: record.container, appId: record.appId, windowId: record.windowId };
	}

	/** Resolve the container owning a TAB renderer's webContents — used by the
	 *  "New Tab" menu action to target the focused window (the focused
	 *  webContents is the active tab's view, not the strip). */
	containerForTabSender(
		webContentsId: number,
	): { container: WindowContainer; appId: string; windowId: string } | null {
		const hit = this.tabIndex.get(webContentsId);
		if (!hit || hit.record.container.baseWindow.isDestroyed()) return null;
		return {
			container: hit.record.container,
			appId: hit.record.appId,
			windowId: hit.record.windowId,
		};
	}

	// ── internal ───────────────────────────────────────────────────────────

	private createContainer(appId: string, windowId: string, theme?: ThemeName): ContainerRecord {
		const key = `${appId}::${windowId}`;
		const title = this.options.resolveAppName?.(appId) ?? appId;
		const baseWindow = this.options.containerFactory({
			appId,
			windowId,
			title,
			backgroundColor: backgroundColorForTheme(theme),
		});
		const record: ContainerRecord = {
			key,
			appId,
			windowId,
			parked: false,
			chromeWcId: null,
			container: undefined as unknown as WindowContainer,
		};
		record.container = new WindowContainer({
			appId,
			baseWindow,
			tabViewFactory: this.options.tabViewFactory,
			nextTabId: () => `tab-${++this.tabSeq}`,
			reveal: (w) => revealWindow(w),
			onTabCreated: (_c, tab) => {
				this.options.identities.register(tab.webContentsId, appId);
				this.tabIndex.set(tab.webContentsId, { record, tabId: tab.tabId });
			},
			onTabClosed: (_c, tab) => {
				this.options.identities.unregister(tab.webContentsId);
				this.tabIndex.delete(tab.webContentsId);
			},
			onChanged: () => this.notifyWindowsChanged(),
			onEmpty: () => this.evict(key, record),
		});
		this.containers.set(key, record);
		this.recordByContainerId.set(record.container.id, record);

		// Mount the shell-drawn tab strip (when a chrome factory is provided).
		if (this.options.chromeViewFactory) {
			const chromeView = this.options.chromeViewFactory(theme ? { appId, theme } : { appId });
			record.container.mountChrome(chromeView, STRIP_HEIGHT_PX);
			record.chromeWcId = record.container.chromeWebContentsId();
			if (record.chromeWcId !== null) this.chromeIndex.set(record.chromeWcId, record);
		}

		// Warm-keep: the user closing the OS window parks the whole container
		// (hide, keep tab renderers alive). `close` is preventable; `closed` is
		// the real teardown.
		const onClose = (event: { preventDefault(): void }) => {
			if (this.containers.get(key) !== record) return;
			if (this.quitting || this.evicting.has(key) || record.parked) return;
			event.preventDefault();
			this.park(key, record);
		};
		const onClosed = () => {
			for (const tab of record.container.tabs()) {
				this.options.identities.unregister(tab.webContentsId);
				this.tabIndex.delete(tab.webContentsId);
			}
			if (record.chromeWcId !== null) this.chromeIndex.delete(record.chromeWcId);
			this.containers.delete(key);
			this.recordByContainerId.delete(record.container.id);
			this.removeFromParkedOrder(key);
			this.evicting.delete(key);
			this.notifyWindowsChanged();
			// A parked window was already invisible — tearing it down moves no
			// focus. A visible one (last-tab close, app uninstall) does.
			if (!record.parked) this.handOffFocusToDashboard();
		};
		baseWindow.on("close", onClose as (...a: unknown[]) => void);
		baseWindow.on("closed", onClosed);
		return record;
	}

	private resolveAppRecord(opts: LaunchOptions): ReturnType<AppsRepository["getActive"]> {
		const appRecord = this.options.appsRepo.getActive(opts.appId);
		if (!appRecord) throw new Error(`AppLauncher: app ${opts.appId} is not installed`);
		if (appRecord.bundleDir !== opts.bundleDir) {
			throw new Error(
				`AppLauncher: bundleDir mismatch for ${opts.appId} (caller said ${opts.bundleDir}, registry says ${appRecord.bundleDir})`,
			);
		}
		return appRecord;
	}

	private addTabFor(record: ContainerRecord, opts: LaunchOptions): Tab {
		const appRecord = this.resolveAppRecord(opts);
		if (!appRecord) throw new Error(`AppLauncher: app ${opts.appId} is not installed`);
		const preloadPath = join(this.options.mainDir, "../preload/app-preload.js");
		const handshake: AppHandshake = {
			app: { id: opts.appId, version: opts.version, sdkVersion: opts.sdk },
			capabilities: opts.capabilities,
			launch: opts.launch,
			...(opts.locale ? { locale: opts.locale } : {}),
			...(opts.format ? { format: opts.format } : {}),
		};
		const buildSha = appRecord.bundleSha256.slice(0, 8);
		const additionalArguments = [
			`--brainstorm-app-id=${opts.appId}`,
			`--brainstorm-handshake=${encodeHandshake(handshake)}`,
			`--brainstorm-build=${buildSha}`,
		];
		if (opts.theme) additionalArguments.push(`--brainstorm-theme=${opts.theme}`);
		console.info(
			`[shell] launch ${opts.appId} v${opts.version} build ${buildSha} dir ${appRecord.bundleDir}`,
		);
		return record.container.addTab({
			entryUrl: this.entryUrl(appRecord.bundleDir, opts.entryPath, appRecord.bundleSha256),
			preloadPath,
			additionalArguments,
			backgroundColor: backgroundColorForTheme(opts.theme),
			route: routeForLaunch(opts.launch),
			title: this.options.resolveAppName?.(opts.appId) ?? opts.appId,
		});
	}

	private snapshot(record: ContainerRecord, tab: Tab): AppWindow {
		return {
			appId: record.appId,
			windowId: record.windowId,
			tabId: tab.tabId,
			webContentsId: tab.webContentsId,
			webContents: tab.view.webContents,
			container: record.container,
			parked: record.parked,
		};
	}

	private park(key: string, record: ContainerRecord): void {
		record.parked = true;
		const window = record.container.baseWindow;
		const hideAndHandOff = () => {
			if (!record.parked) return; // unparked while leaving fullscreen
			if (!window.isDestroyed()) window.hide();
			this.handOffFocusToDashboard();
		};
		// Hiding a window that is still in macOS native fullscreen strands its
		// Space as an empty black screen — leave fullscreen first, hide once
		// the transition completes.
		if (!window.isDestroyed() && window.isFullScreen()) {
			window.once("leave-full-screen", hideAndHandOff);
			window.setFullScreen(false);
		} else {
			hideAndHandOff();
		}
		this.removeFromParkedOrder(key);
		this.parkedOrder.unshift(key);
		this.notifyWindowsChanged();
		this.scheduleEvictionOverCap();
	}

	/** After a visible window goes away, focus must land somewhere. With other
	 *  live app windows around the OS picks the next one in z-order; with none
	 *  left, reveal the dashboard explicitly — it may sit hidden or on another
	 *  macOS Space and never takes over on its own. */
	private handOffFocusToDashboard(): void {
		if (this.quitting) return;
		for (const record of this.containers.values()) {
			if (record.parked) continue;
			if (record.container.baseWindow.isDestroyed()) continue;
			return;
		}
		this.options.revealDashboard?.();
	}

	private scheduleEvictionOverCap(): void {
		if (this.parkedOrder.length <= this.maxParkedWindows) return;
		setImmediate(() => {
			let changed = false;
			while (this.parkedOrder.length > this.maxParkedWindows) {
				const lruKey = this.parkedOrder.at(-1);
				if (lruKey === undefined) break;
				const lru = this.containers.get(lruKey);
				if (lru) {
					this.evict(lruKey, lru);
					changed = true;
				} else {
					this.removeFromParkedOrder(lruKey);
				}
			}
			if (changed) this.notifyWindowsChanged();
		});
	}

	private unpark(key: string, record: ContainerRecord): void {
		record.parked = false;
		this.removeFromParkedOrder(key);
		revealWindow(record.container.baseWindow);
		this.notifyWindowsChanged();
	}

	/** Raise an existing container to the front when its icon is clicked again.
	 *  A bare `focus()` is a no-op for a window that is minimized or sitting
	 *  behind the dashboard — restore it, reveal it (raises + honors the
	 *  no-focus harness flag), then take OS focus. */
	private bringToFront(window: BaseWindowHandle): void {
		if (window.isDestroyed()) return;
		if (window.isMinimized()) window.restore();
		revealWindow(window);
		if (!focusStealingDisabled()) window.focus();
	}

	/** Force-teardown a container, bypassing the park interceptor. Uses
	 *  `dispose()` → `BaseWindow.destroy()` (immediate teardown that skips the
	 *  preventable `close` event + the macOS title-bar close-button path that
	 *  corrupts AppKit's window-chrome heap when a hidden window is destroyed
	 *  amid window churn — see git history of the BrowserWindow-era launcher). */
	private evict(key: string, record: ContainerRecord): void {
		// Do NOT remove the `closed` listener first — `dispose()` destroys the
		// BaseWindow, which fires `closed`, and that handler is what removes the
		// container from the map + LRU. Detaching it here would strand the record
		// in `parkedOrder` and spin the over-cap eviction loop forever.
		this.evicting.add(key);
		record.container.dispose();
	}

	private removeFromParkedOrder(key: string): void {
		const i = this.parkedOrder.indexOf(key);
		if (i !== -1) this.parkedOrder.splice(i, 1);
	}

	private entryUrl(bundleDir: string, entryPath: string, bundleSha256: string): string {
		// `?v=<bundle sha>` busts Chromium's file:// cache so a reinstall that
		// rewrites the bundle in place (dev reseed) serves fresh entry HTML.
		return `file://${join(bundleDir, entryPath)}?v=${bundleSha256.slice(0, 8)}`;
	}
}

/** The cross-app route a launch context addresses, or null for a non-entity
 *  launch (fresh / session-restore / deep-link handled by the app). */
function routeForLaunch(launch: LaunchContext): string | null {
	if (launch.reason === "open-entity") return entityRoute(launch.entityId);
	return null;
}

export const FALLBACK_WINDOW_BACKGROUND = "#161616";

export function backgroundColorForTheme(theme: ThemeName | undefined): string {
	if (!theme) return FALLBACK_WINDOW_BACKGROUND;
	return themes[theme].color.background.primary;
}
