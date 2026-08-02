/**
 * The one `ipcMain` listener for tool-approval replies (Tool-8).
 *
 * Kept apart from `ToolApprovalHost` so the host stays pure and unit-testable,
 * the same split `wire-app-call.ts` and the capability-prompt host use.
 *
 * SECURITY: only the DASHBOARD may answer. An approval reply arriving from an
 * app renderer would be the app approving itself — the exact hole `Tool-8`
 * exists to close — so the sender is checked against the dashboard's own
 * webContents id and anything else is dropped silently (a logged rejection is
 * itself a signal to an attacker probing the channel).
 */

import { ipcMain } from "electron";
import { TOOL_APPROVAL_REPLY_CHANNEL, type ToolApprovalHost } from "./tool-approval-host";

export function wireToolApprovalIpc(
	host: ToolApprovalHost,
	isDashboard: (webContentsId: number) => boolean,
): void {
	ipcMain.on(
		TOOL_APPROVAL_REPLY_CHANNEL,
		(event, payload: { requestId?: unknown; accept?: unknown }) => {
			if (!isDashboard(event.sender.id)) return;
			host.handleReply(payload ?? {});
		},
	);
}
