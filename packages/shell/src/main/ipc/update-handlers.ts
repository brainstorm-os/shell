/**
 * 13.6 — privileged `update:*` IPC (manual-download update check).
 *
 * Dashboard-only, talks to ipcMain directly (like `vault:*` / `dashboard:*`)
 * — updating is an app-global concern, not a per-app brokered capability.
 * The handlers are thin: every decision lives in the injected
 * `UpdateService` so this file stays IO-free and the service stays the one
 * tested unit.
 */

import { ipcMain } from "electron";
import {
	type AutoUpdateState,
	type UpdateCheckResult,
	type UpdatePrefs,
	toUpdateChannel,
} from "../../shared/update-wire-types";
import type { AutoUpdateEngine } from "../update/auto-update-engine";
import type { UpdateService } from "../update/update-service";

export function registerUpdateHandlers(service: UpdateService): void {
	ipcMain.handle("update:check", async (): Promise<UpdateCheckResult> => await service.check());
	ipcMain.handle("update:get-prefs", async (): Promise<UpdatePrefs> => await service.getPrefs());
	ipcMain.handle(
		"update:set-channel",
		async (_event, channel: unknown): Promise<UpdatePrefs> =>
			await service.setChannel(toUpdateChannel(channel)),
	);
}

/**
 * 13.12 — privileged `update:*` IPC for the in-app (electron-updater)
 * self-update engine. Imperative-only: detect / download / relaunch. The
 * push side (state transitions → renderer) is wired in `index.ts` where the
 * dashboard window exists, via the engine's `onState` callback. Channel
 * selection still rides the 13.6 `update:set-channel` prefs handler above.
 */
export function registerAutoUpdateHandlers(engine: AutoUpdateEngine): void {
	ipcMain.handle("update:get-state", (): AutoUpdateState => engine.getState());
	ipcMain.handle("update:check-auto", async (): Promise<AutoUpdateState> => await engine.check());
	ipcMain.handle("update:download", async (): Promise<AutoUpdateState> => await engine.download());
	ipcMain.handle("update:install", (): void => {
		engine.installNow();
	});
}
