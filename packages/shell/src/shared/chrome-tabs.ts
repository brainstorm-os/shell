/**
 * Wire types + channel names for the shell-drawn tab strip, shared between the
 * main process, the chrome preload, and the tab-strip renderer.
 *
 * Kept free of any `electron` import so the renderer can import the *values*
 * (channel names, the state shape) without dragging the preload — see the
 * renderer-value-import rule in CLAUDE.md.
 */

/** Main → chrome-view push: the current tab set for one container. */
export const CHROME_TABS_STATE_CHANNEL = "chrome:tabs:state";

/** Main → chrome-view push: the active theme *name*. The strip renderer
 *  resolves it through the bundled `@brainstorm-os/tokens` registry (the preload
 *  only forwards the name — see the no-heavy-imports rule in chrome-preload).
 *  Mirrors the bootstrap `--brainstorm-theme=` arg so a live theme switch
 *  repaints the strip the same way the app windows repaint. */
export const CHROME_THEME_CHANNEL = "chrome:theme";

/** Chrome-view → main commands (ipcRenderer.invoke). */
export const CHROME_TABS_ACTIVATE = "chrome:tabs:activate";
export const CHROME_TABS_CLOSE = "chrome:tabs:close";
export const CHROME_TABS_NEW = "chrome:tabs:new";
export const CHROME_TABS_REORDER = "chrome:tabs:reorder";
/** Strip → main: re-send the current state (the strip pulls on mount so it
 *  never depends on the initial push racing its renderer load). */
export const CHROME_TABS_REQUEST = "chrome:tabs:request";

export type ChromeTab = {
	tabId: string;
	title: string;
	/** Favicon URL the app published for its open object (`data:` emoji SVG
	 *  or `brainstorm://icon/…`), or null when it hasn't published one. The
	 *  window-container scheme-gates this — the strip renders it as-is. */
	icon: string | null;
	active: boolean;
};

export type ChromeTabsState = {
	appId: string;
	tabs: ChromeTab[];
};

/** The bridge the chrome preload exposes on `window.brainstormChrome`. */
export type ChromeBridge = {
	/** Active theme name at boot (the renderer applies tokens). */
	initialTheme: string | null;
	onTheme: (listener: (name: string) => void) => () => void;
	onState: (listener: (state: ChromeTabsState) => void) => () => void;
	requestState: () => void;
	activateTab: (tabId: string) => void;
	closeTab: (tabId: string) => void;
	newTab: () => void;
	reorderTabs: (order: string[]) => void;
};
