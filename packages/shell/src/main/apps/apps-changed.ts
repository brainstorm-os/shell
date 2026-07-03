/**
 * `apps:changed` — a payload-free push to the dashboard whenever the installed
 * app set or an app's registrations change (install / update / uninstall /
 * refreshRegistrations). The dashboard's one-shot reads (widget titles, widget
 * iframe entries, the app-icon cache) all race an app (re)install without this
 * signal and then never heal — a widget whose app reinstalls mid-boot stays a
 * slug-titled placeholder until a full restart (F-380).
 *
 * Module-scope target registration (same seam as the vault-entities stale
 * signal) so the installer can broadcast from any construction site without
 * threading a dep through every caller. Electron-free at runtime when no
 * target is registered — unit tests exercise the installer with a no-op.
 */

import type { BrowserWindow } from "electron";

export const APPS_CHANGED_CHANNEL = "apps:changed";

let getTarget: (() => BrowserWindow | null) | null = null;

/** Register the dashboard-window getter (called once at startup). */
export function setAppsChangedTarget(getter: () => BrowserWindow | null): void {
	getTarget = getter;
}

/** Test seam — drop the registered target. */
export function resetAppsChangedTarget(): void {
	getTarget = null;
}

/** Push `apps:changed` to the dashboard. Safe no-op without a live target. */
export function broadcastAppsChanged(): void {
	const win = getTarget?.();
	if (!win || win.webContents.isDestroyed()) return;
	try {
		win.webContents.send(APPS_CHANGED_CHANNEL);
	} catch (error) {
		console.warn("[brainstorm] apps-changed signal to dashboard failed:", error);
	}
}
