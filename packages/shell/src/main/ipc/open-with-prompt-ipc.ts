/**
 * Wires the pure `OpenWithPromptHost` to Electron's ipcMain. Kept
 * separate from the host so the host stays Vitest-testable under Bun
 * (which can't resolve `electron`). Mirrors `os-handoff-prompt-ipc.ts`.
 */

import type { OpenWithDecision } from "@brainstorm-os/sdk-types";
import { ipcMain } from "electron";
import { OPEN_WITH_PROMPT_REPLY_CHANNEL, type OpenWithPromptHost } from "./open-with-prompt";

export function wireOpenWithPromptIpc(host: OpenWithPromptHost): void {
	ipcMain.on(
		OPEN_WITH_PROMPT_REPLY_CHANNEL,
		(_event, reply: { requestId: string; decision: OpenWithDecision }) => {
			host.handleReply(reply);
		},
	);
}
