/**
 * Window hit-testing for the cross-app drag session (DND-2,
 * §Part IV.2). Pure over a `WindowEntry[]` snapshot + a screen point — given a
 * cursor position, resolve which app window is under it and the cursor's
 * position WITHIN that window's content area (what a target needs to place a
 * drop without learning the geometry of any other window).
 *
 * "Top-most" = most-recently-focused among the windows whose bounds contain the
 * point. `WindowIndex.list()` is already sorted by `lastFocusedAt` descending,
 * so the first containing match in that order is the visually-front window.
 * Minimized windows are never hit (they paint nothing). This is the only place
 * the source ↔ target geometry mapping happens, and it stays shell-privileged.
 */

import { type WindowEntry, WindowState } from "@brainstorm-os/protocol/window-types";

export type DragPoint = { x: number; y: number };

export type WindowHit = {
	appId: string;
	windowId: string;
	/** Cursor position relative to the window's top-left content origin. */
	pointInWindow: DragPoint;
};

function contains(entry: WindowEntry, point: DragPoint): boolean {
	const b = entry.bounds;
	return point.x >= b.x && point.x < b.x + b.width && point.y >= b.y && point.y < b.y + b.height;
}

/**
 * Resolve the top-most non-minimized window under `point`, or `null` when the
 * cursor is over empty space. `entries` is expected most-recently-focused first
 * (as `WindowIndex.list()` returns); pass them in that order so the front window
 * wins on overlap.
 */
export function hitTestWindow(entries: readonly WindowEntry[], point: DragPoint): WindowHit | null {
	for (const entry of entries) {
		if (entry.state === WindowState.Minimized) continue;
		if (!contains(entry, point)) continue;
		return {
			appId: entry.appId,
			windowId: entry.windowId,
			pointInWindow: { x: point.x - entry.bounds.x, y: point.y - entry.bounds.y },
		};
	}
	return null;
}
