/**
 * `activity:*` IPC — dashboard-only privileged surface for the background
 * activity center (mirrors `sync-status-handlers.ts`). One accessor channel
 * (`activity:snapshot`, query) + one push channel (same name, main→renderer
 * broadcast on every store change).
 *
 * Apps don't read this — it's shell chrome. Only the dashboard binds.
 */

import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import type { ActivitySnapshot } from "../../activity-types";
import type { BackgroundActivityStore } from "../activity/background-activity-store";

export const ACTIVITY_SNAPSHOT_CHANNEL = "activity:snapshot";

export type ActivityHandlersOptions = {
	getDashboard: () => BrowserWindow | null;
	store: BackgroundActivityStore;
};

let unsubscribe: (() => void) | null = null;
let registered = false;
let active: ActivityHandlersOptions | null = null;

export function registerActivityHandlers(options: ActivityHandlersOptions): void {
	active = options;

	if (!registered) {
		ipcMain.handle(
			ACTIVITY_SNAPSHOT_CHANNEL,
			async (): Promise<ActivitySnapshot> => active?.store.snapshot() ?? { operations: [] },
		);
		registered = true;
	}

	if (unsubscribe) unsubscribe();
	unsubscribe = options.store.onChange((snap) => {
		const target = active?.getDashboard() ?? null;
		if (!target || target.isDestroyed()) return;
		try {
			target.webContents.send(ACTIVITY_SNAPSHOT_CHANNEL, snap);
		} catch (error) {
			console.warn("[brainstorm] activity push failed:", error);
		}
	});
}

export function disposeActivityHandlers(): void {
	if (unsubscribe) {
		unsubscribe();
		unsubscribe = null;
	}
}
