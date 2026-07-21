/**
 * WindowContainer — one OS window (an Electron `BaseWindow`) that hosts a
 * shell-drawn tab strip plus one app renderer per tab, each tab a
 * `WebContentsView`. Only the active tab's view is visible; switching tabs is a
 * show/hide of the child views, so per-tab renderer state (scroll, selection,
 * editor) is preserved — the Chrome model per + 37.
 *
 * Tabs are intra-app in v1: every tab in a container belongs to the same app.
 * Each tab's `webContents` registers separately in the renderer-identity
 * registry (done by the launcher via the `onTabCreated`/`onTabClosed` hooks),
 * so capability isolation stays per-renderer even inside one OS window.
 *
 * Electron is reached only through the duck-typed handles below so the bulk of
 * the container logic is unit-testable without spinning up a real BaseWindow —
 * the same seam the launcher already used for `BrowserWindowFactory`.
 */

import { APP_TAB_COMMAND_CHANNEL, TAB_ICON_NONE, TabCommandKind } from "@brainstorm-os/sdk-types";
import {
	CHROME_TABS_STATE_CHANNEL,
	CHROME_THEME_CHANNEL,
	type ChromeTabsState,
} from "../../shared/chrome-tabs";
import { focusStealingDisabled } from "../window/reveal-window";

export type Rectangle = { x: number; y: number; width: number; height: number };

/** Apps that own an internal tab model (the Browser): the shell's global tab
 *  chords route into the renderer (`window:tab-command`) so the app mutates
 *  its own tab strip, instead of acting on the window-container. */
export function appSelfManagesTabs(appId: string): boolean {
	return appId === "io.brainstorm.browser";
}

const PLATFORM = process.platform;

/** Shell window-management chords intercepted before the app renderer sees them
 *  (the in-app shortcut registry governs app actions; these govern the tab
 *  container, like the OS's own Cmd+W). */
export enum TabChord {
	CloseTab = "close-tab",
	NextTab = "next-tab",
	PrevTab = "prev-tab",
}

/** Map an Electron `before-input-event` input to a tab chord, or null. */
export function tabChordFor(input: {
	type: string;
	key: string;
	control: boolean;
	meta: boolean;
	shift: boolean;
	alt: boolean;
}): TabChord | null {
	if (input.type !== "keyDown" || input.alt) return null;
	const accel = input.meta || input.control;
	const key = input.key.toLowerCase();
	if (accel && !input.shift && key === "w") return TabChord.CloseTab;
	if (input.control && input.key === "Tab") return input.shift ? TabChord.PrevTab : TabChord.NextTab;
	return null;
}
/** Width reserved at the strip's leading edge for macOS traffic lights. */
const TRAFFIC_LIGHT_GUTTER = 80;
/** Width reserved at the strip's trailing edge for the Win/Linux window
 *  controls drawn by `titleBarOverlay`. */
const WINDOWS_CONTROLS_GUTTER = 140;
const LINUX_CONTROLS_GUTTER = 120;

/** The subset of Electron `WebContents` the container drives. */
export interface WebContentsHandle {
	readonly id: number;
	send(channel: string, ...args: unknown[]): void;
	getTitle(): string;
	getURL(): string;
	isDestroyed(): boolean;
	isFocused(): boolean;
	/** Start an OS-level drag of a file out to the desktop (DND-5, scope D). */
	startDrag(item: { file: string; icon: unknown }): void;
	close(): void;
	focus(): void;
	loadURL(url: string): Promise<void> | void;
	on(event: string, listener: (...args: unknown[]) => void): void;
	off(event: string, listener: (...args: unknown[]) => void): void;
}

/** The subset of Electron `WebContentsView` the container drives. */
export interface WebContentsViewHandle {
	readonly webContents: WebContentsHandle;
	setBounds(bounds: Rectangle): void;
	setVisible(visible: boolean): void;
	setBackgroundColor?(color: string): void;
}

interface ChildViewContainer {
	addChildView(view: WebContentsViewHandle): void;
	removeChildView(view: WebContentsViewHandle): void;
}

/** The subset of Electron `BaseWindow` the container drives. Mirrors the
 *  window-level slice of `WindowController` (window-index) plus the
 *  `contentView` child-view surface and lifecycle. */
export interface BaseWindowHandle {
	readonly id: number;
	readonly contentView: ChildViewContainer;
	getContentBounds(): Rectangle;
	getBounds(): Rectangle;
	setBounds(bounds: Rectangle): void;
	setTitle(title: string): void;
	getTitle(): string;
	setBackgroundColor(color: string): void;
	isDestroyed(): boolean;
	isFocused(): boolean;
	isMinimized(): boolean;
	isMaximized(): boolean;
	isFullScreen(): boolean;
	setFullScreen(flag: boolean): void;
	focus(): void;
	show(): void;
	showInactive(): void;
	hide(): void;
	restore(): void;
	minimize(): void;
	maximize(): void;
	unmaximize(): void;
	close(): void;
	destroy(): void;
	on(event: string, listener: (...args: unknown[]) => void): void;
	off(event: string, listener: (...args: unknown[]) => void): void;
	once(event: string, listener: (...args: unknown[]) => void): void;
}

/** What the launcher hands the container to build one tab's renderer. The
 *  factory constructs the `WebContentsView` (preload + sandbox + per-tab
 *  handshake `additionalArguments`) but does NOT load — the container loads
 *  after the view is parented + laid out so first paint has correct bounds. */
export type TabViewFactory = (spec: {
	appId: string;
	preloadPath: string;
	additionalArguments: string[];
	backgroundColor: string;
}) => WebContentsViewHandle;

export type TabSpec = {
	/** Where to load the app entry from (`file://…?v=<sha>`). */
	entryUrl: string;
	preloadPath: string;
	additionalArguments: string[];
	backgroundColor: string;
	/** The cross-app route this tab shows (`brainstorm://entity/<id>`), or null
	 *  for a fresh/landing tab. Seeded from the launch context so focus-existing
	 *  works before the app calls `setRoute`. */
	route: string | null;
	/** Placeholder title shown until the app publishes its object title via
	 *  `document.title` (→ `page-title-updated`). Usually the app's display name. */
	title: string;
};

export type Tab = {
	tabId: string;
	appId: string;
	view: WebContentsViewHandle;
	webContentsId: number;
	route: string | null;
	title: string;
	/** Favicon URL the app published for its open object, or null. */
	icon: string | null;
};

export type WindowContainerOptions = {
	appId: string;
	baseWindow: BaseWindowHandle;
	tabViewFactory: TabViewFactory;
	/** Mint a unique tab id. Injected so tests stay deterministic and the
	 *  runtime avoids `Math.random`. */
	nextTabId: () => string;
	/** Reveal honoring the no-focus harness flag (`revealWindow`). */
	reveal: (window: BaseWindowHandle) => void;
	/** Identity wiring: the launcher registers/unregisters `webContentsId → appId`
	 *  and maintains its reverse index off these. */
	onTabCreated: (container: WindowContainer, tab: Tab) => void;
	onTabClosed: (container: WindowContainer, tab: Tab) => void;
	/** Fired when the active tab, tab set, titles, or routes change — drives the
	 *  tab-strip push and the window-index notify. */
	onChanged: () => void;
	/** Fired when the last tab closes so the launcher can park/teardown the
	 *  container. Distinct from the user closing the OS window. */
	onEmpty: (container: WindowContainer) => void;
};

/** Height of the shell-drawn tab strip, in DIP. 0 until a chrome view is
 *  mounted (Stage 2) — Stage 1 containers run strip-less (active tab fills the
 *  whole window, visually identical to the pre-tabs single window). */
const DEFAULT_STRIP_HEIGHT = 0;

export class WindowContainer {
	readonly id: string;
	readonly appId: string;
	readonly baseWindow: BaseWindowHandle;
	private readonly tabsList: Tab[] = [];
	private activeTabId: string | null = null;
	private chromeView: WebContentsViewHandle | null = null;
	private stripHeight = DEFAULT_STRIP_HEIGHT;
	private stripVisible = false;
	private revealed = false;
	private readonly perTabDetach = new Map<string, () => void>();
	private readonly changeListeners = new Set<() => void>();
	private detachBaseWindow: (() => void) | null = null;
	private disposed = false;

	constructor(private readonly options: WindowContainerOptions) {
		this.id = String(options.baseWindow.id);
		this.appId = options.appId;
		this.baseWindow = options.baseWindow;
		this.wireBaseWindow();
	}

	tabs(): readonly Tab[] {
		return this.tabsList;
	}

	activeTab(): Tab | null {
		if (this.activeTabId === null) return null;
		return this.tabsList.find((t) => t.tabId === this.activeTabId) ?? null;
	}

	tabById(tabId: string): Tab | null {
		return this.tabsList.find((t) => t.tabId === tabId) ?? null;
	}

	tabByWebContents(webContentsId: number): Tab | null {
		return this.tabsList.find((t) => t.webContentsId === webContentsId) ?? null;
	}

	activeTitle(): string {
		return this.activeTab()?.title ?? this.appId;
	}

	activeRoute(): string | null {
		return this.activeTab()?.route ?? null;
	}

	/** Subscribe to active-tab / tab-set / title / route changes. The launcher
	 *  drives the tab strip; the window index drives the dashboard. */
	onDidChange(listener: () => void): () => void {
		this.changeListeners.add(listener);
		return () => {
			this.changeListeners.delete(listener);
		};
	}

	/** Mount the shell chrome (tab strip) view above the tabs (Stage 2). The
	 *  chrome view is parented first so it always renders behind/above the tab
	 *  views per the requested strip height. */
	mountChrome(view: WebContentsViewHandle, height: number): void {
		if (this.disposed) return;
		this.chromeView = view;
		this.stripHeight = height;
		this.baseWindow.contentView.addChildView(view);
		// Re-push once the strip renderer has loaded + subscribed — the initial
		// push below races the async renderer load and is otherwise dropped.
		view.webContents.on("did-finish-load", () => this.pushChromeState());
		this.layout();
		this.pushChromeState();
	}

	/** The webContents id of the shell chrome (tab strip), or null when running
	 *  strip-less. The launcher maps it back to this container for IPC commands. */
	chromeWebContentsId(): number | null {
		return this.chromeView?.webContents.id ?? null;
	}

	/** Re-send the current tab state to the strip (the strip pulls this on mount). */
	publishChromeState(): void {
		this.pushChromeState();
	}

	/** Push a live theme-name change to the strip renderer so it repaints its
	 *  tokens — the strip is a separate WebContentsView that doesn't receive
	 *  the app-window `app:theme-changed` broadcast (it only reads the boot
	 *  `--brainstorm-theme=` arg otherwise, leaving the strip stuck on the
	 *  launch-time theme through every later switch). No-op strip-less. */
	pushChromeTheme(themeName: string): void {
		if (!this.chromeView || this.chromeView.webContents.isDestroyed()) return;
		try {
			this.chromeView.webContents.send(CHROME_THEME_CHANNEL, themeName);
		} catch {
			// Chrome renderer gone — harmless.
		}
	}

	addTab(spec: TabSpec): Tab {
		if (this.disposed) throw new Error("WindowContainer: addTab after dispose");
		const view = this.options.tabViewFactory({
			appId: this.appId,
			preloadPath: spec.preloadPath,
			additionalArguments: spec.additionalArguments,
			backgroundColor: spec.backgroundColor,
		});
		const tab: Tab = {
			tabId: this.options.nextTabId(),
			appId: this.appId,
			view,
			webContentsId: view.webContents.id,
			route: spec.route,
			title: spec.title,
			icon: null,
		};
		this.tabsList.push(tab);
		this.options.onTabCreated(this, tab);
		this.wireTab(tab);
		this.baseWindow.contentView.addChildView(view);
		void view.webContents.loadURL(spec.entryUrl);
		// activateTab fires the change notification (new tab is always a switch).
		this.activateTab(tab.tabId);
		return tab;
	}

	activateTab(tabId: string): boolean {
		const target = this.tabById(tabId);
		if (!target) return false;
		if (this.activeTabId === tabId) {
			this.baseWindow.setTitle(target.title);
			return true;
		}
		for (const tab of this.tabsList) {
			const isActive = tab.tabId === tabId;
			tab.view.setVisible(isActive);
			// A non-active tab is hidden for Page-Visibility throttling — pause its
			// render loop; the newly-active tab resumes. (Same signal the
			// per-window hide/show used to drive.)
			this.sendVisibility(tab, isActive);
		}
		this.activeTabId = tabId;
		this.baseWindow.setTitle(target.title);
		this.layout();
		this.focusActiveTab();
		this.fireChanged();
		return true;
	}

	/** Give keyboard focus to the active tab's webContents. Showing the OS window
	 *  focuses the *window*, not the child `WebContentsView`, so until this runs
	 *  `webContents.getFocusedWebContents()` returns null — the symptom being
	 *  shell shortcuts (toggle-devtools, etc.) silently no-op'ing until the user
	 *  clicks into the renderer. */
	private focusActiveTab(): void {
		const active = this.activeTab();
		if (!active || active.view.webContents.isDestroyed()) return;
		try {
			active.view.webContents.focus();
		} catch {
			// Renderer gone between activate and focus — harmless.
		}
	}

	/** Cycle the active tab by `delta` (wraps). Used by the Ctrl+Tab chord. */
	cycleTab(delta: number): boolean {
		if (this.tabsList.length < 2 || this.activeTabId === null) return false;
		const idx = this.tabsList.findIndex((t) => t.tabId === this.activeTabId);
		if (idx < 0) return false;
		const next = this.tabsList[(idx + delta + this.tabsList.length) % this.tabsList.length];
		return next ? this.activateTab(next.tabId) : false;
	}

	/** Close the active tab (the Cmd/Ctrl+W chord). */
	closeActiveTab(): boolean {
		return this.activeTabId !== null ? this.closeTab(this.activeTabId) : false;
	}

	closeTab(tabId: string): boolean {
		const idx = this.tabsList.findIndex((t) => t.tabId === tabId);
		if (idx < 0) return false;
		const [tab] = this.tabsList.splice(idx, 1);
		if (!tab) return false;
		this.teardownTab(tab);
		let relaidOut = false;
		if (this.activeTabId === tabId) {
			const neighbor = this.tabsList[idx] ?? this.tabsList[idx - 1] ?? null;
			this.activeTabId = null;
			if (neighbor) relaidOut = this.activateTab(neighbor.tabId);
		}
		// Dropping to a single tab collapses the strip. Closing a background tab
		// (or the last tab) doesn't re-activate, so `activateTab`'s layout never
		// ran — re-run it here only when it didn't, for the 2→1 collapse.
		if (!relaidOut) this.layout();
		// A strip-initiated close (the tab's × button) leaves keyboard focus in
		// the chrome WebContentsView. When we re-activated a neighbor above,
		// `activateTab` already pulled focus back to the app; but closing a
		// *background* tab doesn't re-activate, so focus would stay stranded in
		// the strip and every shell/app shortcut silently no-op until the user
		// clicks into the renderer. Re-focus the active tab on every close path.
		if (!relaidOut && this.tabsList.length > 0) this.focusActiveTab();
		this.fireChanged();
		if (this.tabsList.length === 0) this.options.onEmpty(this);
		return true;
	}

	reorderTabs(order: string[]): void {
		const byId = new Map(this.tabsList.map((t) => [t.tabId, t] as const));
		const next: Tab[] = [];
		for (const id of order) {
			const tab = byId.get(id);
			if (tab) {
				next.push(tab);
				byId.delete(id);
			}
		}
		// Any tabs not named in `order` keep their relative order at the end.
		for (const tab of this.tabsList) if (byId.has(tab.tabId)) next.push(tab);
		this.tabsList.splice(0, this.tabsList.length, ...next);
		this.fireChanged();
	}

	setRoute(webContentsId: number, route: string | null): void {
		const tab = this.tabByWebContents(webContentsId);
		if (!tab) return;
		tab.route = route;
		this.fireChanged();
	}

	/** Reveal the OS window (showInactive under the harness). Idempotent. */
	reveal(): void {
		if (this.revealed || this.disposed) return;
		this.revealed = true;
		this.options.reveal(this.baseWindow);
		// `activateTab` ran before the page loaded, so the initial focus didn't
		// stick; re-focus on first paint. Gated on the no-focus harness flag so
		// Playwright launches don't steal the developer's OS focus.
		if (!focusStealingDisabled()) this.focusActiveTab();
		this.emitFullscreen();
	}

	layout(): void {
		if (this.disposed || this.baseWindow.isDestroyed()) return;
		const bounds = safe(() => this.baseWindow.getContentBounds(), {
			x: 0,
			y: 0,
			width: 0,
			height: 0,
		});
		// Inset the strip past the OS window controls so it never swallows their
		// clicks: macOS traffic lights sit top-left (hidden in fullscreen);
		// Windows/Linux `titleBarOverlay` reserves the top-right. The uncovered
		// gutter shows the window frame (and its controls) through.
		const fullscreen = safe(() => this.baseWindow.isFullScreen(), false);
		const left = PLATFORM === "darwin" && !fullscreen ? TRAFFIC_LIGHT_GUTTER : 0;
		const right =
			PLATFORM === "win32"
				? WINDOWS_CONTROLS_GUTTER
				: PLATFORM === "linux"
					? LINUX_CONTROLS_GUTTER
					: 0;
		// The strip earns its vertical space only with 2+ tabs. A lone tab is the
		// window, not something to switch between, so the strip collapses and the
		// app fills the frame — its own `.app-header` already reserves the
		// traffic-light gutter, so this is visually the pre-tabs single window.
		const stripVisible = this.chromeView !== null && this.tabsList.length > 1;
		if (stripVisible !== this.stripVisible) {
			this.stripVisible = stripVisible;
			// The strip row now owns (or releases) the OS window-control gutter, so
			// the app header below no longer needs to reserve it. Tell every tab.
			for (const tab of this.tabsList) this.sendStripVisible(tab, stripVisible);
		}
		const stripH = stripVisible ? this.stripHeight : 0;
		// Bleed the strip 1px past its nominal bottom so it underlaps the active
		// tab view (which is added later → painted on top, so it covers the
		// overlap). Two adjacent WebContentsViews that merely abut at `y = stripH`
		// leave a 1px sub-pixel seam on fractional-DPR displays, through which the
		// near-black BaseWindow paint shows as a black hairline under the tabs.
		// Backing that seam row with chrome glass instead of raw window paint
		// makes it invisible.
		const strip: Rectangle = {
			x: left,
			y: 0,
			width: Math.max(0, bounds.width - left - right),
			height: stripVisible ? stripH + 1 : 0,
		};
		const body: Rectangle = {
			x: 0,
			y: stripH,
			width: bounds.width,
			height: Math.max(0, bounds.height - stripH),
		};
		if (this.chromeView) {
			this.chromeView.setVisible(stripVisible);
			this.chromeView.setBounds(strip);
		}
		const active = this.activeTab();
		if (active) active.view.setBounds(body);
	}

	/** The window-content rect the active app tab occupies (below the tab
	 *  strip). The Browser app's chrome measures its web-region in its own
	 *  viewport (origin = this rect's top-left), so Browser-2 offsets a web
	 *  `WebContentsView` by this origin to land it in window-content coords. */
	bodyBounds(): Rectangle {
		const bounds = safe(() => this.baseWindow.getContentBounds(), {
			x: 0,
			y: 0,
			width: 0,
			height: 0,
		});
		const stripVisible = this.chromeView !== null && this.tabsList.length > 1;
		const stripH = stripVisible ? this.stripHeight : 0;
		return { x: 0, y: stripH, width: bounds.width, height: Math.max(0, bounds.height - stripH) };
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.detachBaseWindow?.();
		this.detachBaseWindow = null;
		for (const tab of [...this.tabsList]) this.teardownTab(tab);
		this.tabsList.length = 0;
		this.activeTabId = null;
		if (!this.baseWindow.isDestroyed()) this.baseWindow.destroy();
	}

	// ── internal ───────────────────────────────────────────────────────────

	private fireChanged(): void {
		this.pushChromeState();
		this.options.onChanged();
		for (const listener of this.changeListeners) {
			try {
				listener();
			} catch (error) {
				console.warn("[WindowContainer] change listener threw:", error);
			}
		}
	}

	private pushChromeState(): void {
		if (!this.chromeView || this.chromeView.webContents.isDestroyed()) return;
		const state: ChromeTabsState = {
			appId: this.appId,
			tabs: this.tabsList.map((tab) => ({
				tabId: tab.tabId,
				title: tab.title,
				icon: tab.icon,
				active: tab.tabId === this.activeTabId,
			})),
		};
		try {
			this.chromeView.webContents.send(CHROME_TABS_STATE_CHANNEL, state);
		} catch {
			// Chrome renderer gone — harmless.
		}
	}

	private wireBaseWindow(): void {
		const onResize = () => this.layout();
		const onFullscreen = () => {
			this.layout();
			this.emitFullscreen();
		};
		const onHide = () => this.broadcastVisibility(false);
		const onShow = () => this.broadcastVisibility(true);
		this.baseWindow.on("resize", onResize);
		this.baseWindow.on("enter-full-screen", onFullscreen);
		this.baseWindow.on("leave-full-screen", onFullscreen);
		this.baseWindow.on("minimize", onHide);
		this.baseWindow.on("restore", onShow);
		this.baseWindow.on("hide", onHide);
		this.baseWindow.on("show", onShow);
		this.detachBaseWindow = () => {
			this.baseWindow.off("resize", onResize);
			this.baseWindow.off("enter-full-screen", onFullscreen);
			this.baseWindow.off("leave-full-screen", onFullscreen);
			this.baseWindow.off("minimize", onHide);
			this.baseWindow.off("restore", onShow);
			this.baseWindow.off("hide", onHide);
			this.baseWindow.off("show", onShow);
		};
	}

	private wireTab(tab: Tab): void {
		const wc = tab.view.webContents;
		const onTitle = () => {
			if (wc.isDestroyed()) return;
			tab.title = wc.getTitle();
			if (tab.tabId === this.activeTabId) this.baseWindow.setTitle(tab.title);
			this.fireChanged();
		};
		// The app's favicon labels the tab with its open object's icon (the icon
		// twin of `page-title-updated`; published via `@brainstorm-os/sdk/tab-identity`).
		// Scheme gate, same invariant as entity-icon's parseIcon: `properties.icon`
		// is app-authored, and the URL becomes an `img.src` in the privileged strip
		// renderer — only inline data and the vault icon protocol may pass, never
		// an `https://…` egress beacon. TAB_ICON_NONE is the explicit "no icon"
		// (removing the page's `<link>` doesn't re-fire the event).
		const onFavicon = (...args: unknown[]) => {
			const favicons = args[1];
			const url = Array.isArray(favicons)
				? favicons.find((f): f is string => typeof f === "string")
				: undefined;
			const allowed = url && (url.startsWith("data:image/") || url.startsWith("brainstorm:"));
			const icon = allowed && url !== TAB_ICON_NONE ? url : null;
			if (tab.icon === icon) return;
			tab.icon = icon;
			this.fireChanged();
		};
		// First paint reveals the window (BaseWindow has no `ready-to-show`).
		// `dom-ready` fires earlier and on more paths than `did-finish-load`
		// (including when a sub-resource load stalls), so the window never gets
		// stuck invisible; `reveal()` is idempotent so both firing is fine.
		const onLoaded = () => {
			this.reveal();
			// A tab can finish loading after the strip is already up (opened into an
			// existing multi-tab window); its preload assumed the single-tab gutter,
			// so re-send the live state once it can receive it.
			this.sendStripVisible(tab, this.stripVisible);
		};
		// Shell window-management chords (close tab / cycle tabs) are intercepted
		// before the app renderer sees them.
		const onChord = (...args: unknown[]) => {
			const event = args[0] as { preventDefault: () => void };
			const chord = tabChordFor(args[1] as Parameters<typeof tabChordFor>[0]);
			if (!chord) return;
			event.preventDefault();
			if (chord === TabChord.CloseTab) {
				// A self-tabbing app owns Cmd+W: forward it to the renderer (which
				// closes a tab in its own strip) instead of closing the container tab.
				if (appSelfManagesTabs(this.appId)) {
					wc.send(APP_TAB_COMMAND_CHANNEL, { kind: TabCommandKind.CloseTab });
				} else {
					this.closeActiveTab();
				}
			} else this.cycleTab(chord === TabChord.NextTab ? 1 : -1);
		};
		wc.on("page-title-updated", onTitle);
		wc.on("page-favicon-updated", onFavicon);
		wc.on("did-finish-load", onLoaded);
		wc.on("dom-ready", onLoaded);
		wc.on("before-input-event", onChord);
		this.perTabDetach.set(tab.tabId, () => {
			try {
				wc.off("page-title-updated", onTitle);
				wc.off("page-favicon-updated", onFavicon);
				wc.off("did-finish-load", onLoaded);
				wc.off("dom-ready", onLoaded);
				wc.off("before-input-event", onChord);
			} catch {
				// Renderer already gone — Electron cleaned the listeners up.
			}
		});
	}

	private teardownTab(tab: Tab): void {
		this.perTabDetach.get(tab.tabId)?.();
		this.perTabDetach.delete(tab.tabId);
		try {
			if (!this.baseWindow.isDestroyed()) this.baseWindow.contentView.removeChildView(tab.view);
		} catch {
			// Window mid-teardown — child views go with it.
		}
		try {
			if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
		} catch {
			// Already closed.
		}
		this.options.onTabClosed(this, tab);
	}

	private sendVisibility(tab: Tab, visible: boolean): void {
		// `webContents` is undefined (not just destroyed) when a tab's view is
		// torn down while the window still fires a hide/show visibility event —
		// the BaseWindow `hide`/`show` → broadcastVisibility race. Guard the
		// whole reference, not only `isDestroyed()`.
		const wc = tab.view?.webContents;
		if (!wc || wc.isDestroyed()) return;
		try {
			wc.send("window:visibility-changed", visible);
		} catch {
			// Renderer gone between activate and send — harmless.
		}
	}

	private broadcastVisibility(visible: boolean): void {
		for (const tab of this.tabsList) {
			// When the whole window hides, every tab is hidden; when it shows, only
			// the active tab becomes visible again (others stay paused).
			this.sendVisibility(tab, visible && tab.tabId === this.activeTabId);
		}
	}

	private sendStripVisible(tab: Tab, visible: boolean): void {
		const wc = tab.view?.webContents;
		if (!wc || wc.isDestroyed()) return;
		try {
			wc.send("window:strip-visible-changed", visible);
		} catch {
			// Renderer gone between layout and send — harmless.
		}
	}

	private emitFullscreen(): void {
		if (this.baseWindow.isDestroyed()) return;
		const fs = safe(() => this.baseWindow.isFullScreen(), false);
		for (const tab of this.tabsList) {
			if (tab.view.webContents.isDestroyed()) continue;
			try {
				tab.view.webContents.send("window:fullscreen-changed", fs);
			} catch {
				// Renderer gone — harmless.
			}
		}
	}
}

function safe<T>(fn: () => T, fallback: T): T {
	try {
		return fn();
	} catch {
		return fallback;
	}
}
