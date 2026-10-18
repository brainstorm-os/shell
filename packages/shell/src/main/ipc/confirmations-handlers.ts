/**
 * 6.15 — the shell's remembered confirmation choices ("Don't ask again").
 *
 * The dashboard renderer's own prompts store their skips in the `settings`
 * table under the reserved `shell` namespace (an id no app may install as —
 * `RESERVED_APP_IDS`), beside the skips apps store in their own namespaces via
 * the `settings` service. `reset` is the Settings → Interface → "Reset
 * confirmations" action and clears every namespace's. Both writes go through
 * `canRememberConfirm`, so an irreversible kind can never be skipped.
 */

import { ConfirmKind, canRememberConfirm, confirmSkipKey } from "@brainstorm-os/sdk-types";
import type { IpcMain } from "electron";
import type { SettingsRepository } from "../storage/settings-repo";

export const SHELL_SETTINGS_NAMESPACE = "shell";

export type ConfirmationsApi = {
	list(): Promise<ConfirmKind[]>;
	remember(kind: unknown): Promise<boolean>;
	reset(): Promise<number>;
};

export function makeConfirmationsApi(
	getRepo: () => Promise<SettingsRepository | null>,
): ConfirmationsApi {
	return {
		async list() {
			const repo = await getRepo();
			if (!repo) return [];
			return Object.values(ConfirmKind).filter(
				(kind) =>
					canRememberConfirm(kind) && repo.get(SHELL_SETTINGS_NAMESPACE, confirmSkipKey(kind)) !== null,
			);
		},
		async remember(kind) {
			if (!canRememberConfirm(kind)) return false;
			const repo = await getRepo();
			if (!repo) return false;
			repo.set(SHELL_SETTINGS_NAMESPACE, confirmSkipKey(kind), "true");
			return true;
		},
		async reset() {
			const repo = await getRepo();
			if (!repo) return 0;
			let cleared = 0;
			for (const kind of Object.values(ConfirmKind)) {
				cleared += repo.deleteKeyForAllApps(confirmSkipKey(kind));
			}
			return cleared;
		},
	};
}

export function registerConfirmationsHandlers(ipc: IpcMain, api: ConfirmationsApi): void {
	ipc.handle("confirmations:list", () => api.list());
	ipc.handle("confirmations:remember", (_event, kind: unknown) => api.remember(kind));
	ipc.handle("confirmations:reset", () => api.reset());
}
