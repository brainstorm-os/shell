/**
 * IPC handlers for the shell-drawn tab strip. Registered once at startup.
 *
 * Every command resolves the target container from the IPC *sender's*
 * webContents id (`launcher.containerForChromeSender`), never from a
 * client-supplied id — so a tab strip can only ever drive its own container.
 * A sender that isn't a known chrome view resolves to null and the command is
 * a no-op (fail-closed).
 */

import {
	CHROME_TABS_ACTIVATE,
	CHROME_TABS_CLOSE,
	CHROME_TABS_NEW,
	CHROME_TABS_REORDER,
	CHROME_TABS_REQUEST,
} from "@brainstorm-os/protocol/chrome-tabs";
import { ipcMain } from "electron";
import type { LaunchOrchestrator } from "../apps/launch-orchestrator";
import type { AppLauncher } from "../apps/launcher";

export type ChromeTabsHandlersContext = {
	getLauncher: () => AppLauncher | null;
	getOrchestrator: () => Promise<LaunchOrchestrator | null>;
};

export function registerChromeTabsHandlers(ctx: ChromeTabsHandlersContext): () => void {
	const resolve = (senderId: number) =>
		ctx.getLauncher()?.containerForChromeSender(senderId) ?? null;

	const onActivate = (event: Electron.IpcMainInvokeEvent, tabId: unknown): void => {
		if (typeof tabId !== "string") return;
		resolve(event.sender.id)?.container.activateTab(tabId);
	};
	const onClose = (event: Electron.IpcMainInvokeEvent, tabId: unknown): void => {
		if (typeof tabId !== "string") return;
		resolve(event.sender.id)?.container.closeTab(tabId);
	};
	const onReorder = (event: Electron.IpcMainInvokeEvent, order: unknown): void => {
		if (!Array.isArray(order) || !order.every((id) => typeof id === "string")) return;
		resolve(event.sender.id)?.container.reorderTabs(order as string[]);
	};
	const onNew = async (event: Electron.IpcMainInvokeEvent): Promise<void> => {
		const hit = resolve(event.sender.id);
		if (!hit) return;
		const orchestrator = await ctx.getOrchestrator();
		try {
			await orchestrator?.addTab(hit.container.id, {
				appId: hit.appId,
				launch: { reason: "fresh" },
			});
		} catch (error) {
			console.warn("[chrome-tabs] new tab failed:", error);
		}
	};

	const onRequest = (event: Electron.IpcMainInvokeEvent): void => {
		resolve(event.sender.id)?.container.publishChromeState();
	};

	ipcMain.handle(CHROME_TABS_ACTIVATE, onActivate);
	ipcMain.handle(CHROME_TABS_CLOSE, onClose);
	ipcMain.handle(CHROME_TABS_REORDER, onReorder);
	ipcMain.handle(CHROME_TABS_NEW, onNew);
	ipcMain.handle(CHROME_TABS_REQUEST, onRequest);

	return () => {
		ipcMain.removeHandler(CHROME_TABS_ACTIVATE);
		ipcMain.removeHandler(CHROME_TABS_CLOSE);
		ipcMain.removeHandler(CHROME_TABS_REORDER);
		ipcMain.removeHandler(CHROME_TABS_NEW);
		ipcMain.removeHandler(CHROME_TABS_REQUEST);
	};
}
