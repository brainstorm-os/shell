/**
 * 13.12 — electron-updater binding for the AutoUpdateEngine.
 *
 * Adapts electron-updater's `autoUpdater` singleton to the engine's
 * `ManagedAutoUpdater` interface. This is the Electron/IO edge (like 13.6's
 * `update-feed-fetch.ts`); the tested logic lives in `auto-update-engine.ts`.
 *
 * Feed: the GitHub `publish` provider in package.json bakes `app-update.yml`
 * into the build, so electron-updater knows where to read `latest*.yml` with
 * no runtime URL. `autoDownload` is OFF — a check only detects; the engine
 * downloads on explicit user action. Code-signature verification is
 * electron-updater's own (macOS Developer ID match / Windows publisher), so a
 * compromised feed can't push an artefact signed by a different identity.
 */

import { app } from "electron";
import electronUpdater, { type ProgressInfo, type UpdateInfo } from "electron-updater";
import { UpdateChannel } from "../../shared/update-wire-types";
import type { AutoUpdaterHandlers, ManagedAutoUpdater } from "./auto-update-engine";

const { autoUpdater } = electronUpdater;

/** Self-update only runs from a packaged build with an `app-update.yml`;
 *  dev/unpackaged stays on the 13.6 manual-download fallback. */
export function isAutoUpdateSupported(): boolean {
	return app.isPackaged;
}

export function createElectronAutoUpdater(): ManagedAutoUpdater {
	autoUpdater.autoDownload = false;
	// A staged update still applies on the next natural quit even if the user
	// doesn't click "Restart & install".
	autoUpdater.autoInstallOnAppQuit = true;

	return {
		setChannel(channel: UpdateChannel): void {
			if (channel === UpdateChannel.Beta) {
				autoUpdater.allowPrerelease = true;
				autoUpdater.channel = "beta";
			} else {
				autoUpdater.allowPrerelease = false;
				autoUpdater.channel = "latest";
			}
		},
		async checkForUpdates(): Promise<void> {
			await autoUpdater.checkForUpdates();
		},
		async downloadUpdate(): Promise<void> {
			await autoUpdater.downloadUpdate();
		},
		quitAndInstall(): void {
			autoUpdater.quitAndInstall();
		},
		on(handlers: AutoUpdaterHandlers): void {
			autoUpdater.on("checking-for-update", () => handlers.onCheckingForUpdate());
			autoUpdater.on("update-available", (info: UpdateInfo) =>
				handlers.onUpdateAvailable(info.version),
			);
			autoUpdater.on("update-not-available", () => handlers.onUpdateNotAvailable());
			autoUpdater.on("download-progress", (progress: ProgressInfo) =>
				handlers.onDownloadProgress({
					percent: Math.round(progress.percent),
					transferred: progress.transferred,
					total: progress.total,
					bytesPerSecond: progress.bytesPerSecond,
				}),
			);
			autoUpdater.on("update-downloaded", (info: UpdateInfo) =>
				handlers.onUpdateDownloaded(info.version),
			);
			autoUpdater.on("error", (error: Error) => handlers.onError(error.message));
		},
	};
}
