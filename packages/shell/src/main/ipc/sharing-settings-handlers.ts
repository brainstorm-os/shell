/**
 * Collab-C7 — Settings → Identity → "New shares start as". Privileged ipcMain
 * (the dashboard renderer only); apps read the value through the gated
 * `sharing.defaultRole` and can never set it. Only Viewer / Editor are
 * accepted — anything else leaves the stored value as it was.
 */

import type { RosterRole } from "@brainstorm-os/sdk-types";
import { ipcMain } from "electron";
import { readDefaultShareRole, writeDefaultShareRole } from "../sharing/share-defaults";
import type { SettingsRepository } from "../storage/settings-repo";

export const SHARING_GET_DEFAULT_ROLE_CHANNEL = "sharing-settings:get-default-role" as const;
export const SHARING_SET_DEFAULT_ROLE_CHANNEL = "sharing-settings:set-default-role" as const;

export function registerSharingSettingsHandlers(options: {
	getSettingsRepo: () => Promise<SettingsRepository | null>;
}): void {
	ipcMain.handle(
		SHARING_GET_DEFAULT_ROLE_CHANNEL,
		async (): Promise<RosterRole> => readDefaultShareRole(await options.getSettingsRepo()),
	);
	ipcMain.handle(
		SHARING_SET_DEFAULT_ROLE_CHANNEL,
		async (_event, role: unknown): Promise<RosterRole> =>
			writeDefaultShareRole(await options.getSettingsRepo(), role),
	);
}
