/**
 * `backup:*` IPC (IE-14) — the dashboard-only surface over {@link BackupService}
 * for Settings → Backup & migration. Privileged like `import-export:*`: wired
 * into the dashboard preload only; apps never reach scheduled backups.
 */

import { type BrowserWindow, dialog, ipcMain, shell } from "electron";
import type { BackupService, BackupStatus, RestorePoint } from "../bundle/backup-service";
import type { ImportReport } from "../bundle/bundle-format";

export type BackupHandlersOptions = {
	service: BackupService;
	getDashboard: () => BrowserWindow | null;
};

export function registerBackupHandlers(options: BackupHandlersOptions): void {
	const { service } = options;

	ipcMain.handle("backup:status", (): Promise<BackupStatus | null> => service.getStatus());

	ipcMain.handle(
		"backup:update-schedule",
		(_event, patch: unknown): Promise<BackupStatus | null> => {
			const p = patch && typeof patch === "object" ? (patch as Record<string, unknown>) : {};
			return service.updateSchedule({ frequency: p.frequency, retention: p.retention });
		},
	);

	ipcMain.handle("backup:pick-folder", async (): Promise<BackupStatus | null> => {
		const win = options.getDashboard();
		const dialogOptions = {
			title: "Choose a backup folder",
			buttonLabel: "Use this folder",
			properties: ["openDirectory" as const, "createDirectory" as const],
		};
		const result = win
			? await dialog.showOpenDialog(win, dialogOptions)
			: await dialog.showOpenDialog(dialogOptions);
		const folder = result.filePaths[0];
		if (result.canceled || !folder) return service.getStatus();
		return service.setFolder(folder);
	});

	ipcMain.handle("backup:run-now", (): Promise<BackupStatus | null> => service.runNow());

	ipcMain.handle(
		"backup:restore-points",
		(): Promise<RestorePoint[]> => service.listRestorePoints(),
	);

	ipcMain.handle(
		"backup:restore",
		(_event, name: unknown): Promise<ImportReport> => service.restore(name),
	);

	ipcMain.handle("backup:open-folder", async (): Promise<void> => {
		const status = await service.getStatus();
		if (status?.folder) await shell.openPath(status.folder);
	});
}
