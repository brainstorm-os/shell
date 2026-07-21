/**
 * Shell-internal window types shared between main, preload, and renderer.
 *
 * Kept in a dedicated module so the renderer can import `TilePreset` /
 * `WindowState` *values* without dragging `preload/index.ts` (which imports
 * `electron`) into the renderer bundle.
 */

export enum WindowState {
	Normal = "normal",
	Minimized = "minimized",
	Maximized = "maximized",
	Fullscreen = "fullscreen",
}

export enum TilePreset {
	Fill = "fill",
	LeftHalf = "left-half",
	RightHalf = "right-half",
	TopHalf = "top-half",
	BottomHalf = "bottom-half",
	TopLeft = "top-left",
	TopRight = "top-right",
	BottomLeft = "bottom-left",
	BottomRight = "bottom-right",
	Center = "center",
}

/** What to do with a navigation result — the four browser-identical modes
 *  (panels are post-v1). Plain click = Replace; Cmd/Ctrl+Click = NewTab;
 *  Shift+Click = NewWindow. Per. */
export enum NavigationMode {
	Replace = "replace",
	NewTab = "new-tab",
	NewWindow = "new-window",
}

export type WindowBounds = { x: number; y: number; width: number; height: number };

export type WindowEntry = {
	/** Composite "{appId}::{windowId}" — stable across the window's lifetime. */
	id: string;
	appId: string;
	appName: string;
	windowId: string;
	title: string;
	/** The cross-app route the (active tab of the) window currently shows, or
	 *  null for landing/empty state. Per */
	route: string | null;
	monitorId: string;
	bounds: WindowBounds;
	state: WindowState;
	focused: boolean;
	lastFocusedAt: number;
};

export type MonitorSummary = {
	id: string;
	label: string;
	primary: boolean;
	bounds: WindowBounds;
	workArea: WindowBounds;
};
