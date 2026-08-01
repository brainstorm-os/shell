/**
 * Electron wiring for `AppCallHost` (Tool-1). One `ipcMain` listener on the
 * reply channel; the request direction is the host's own `sender.send`.
 *
 * The reply-identity invariant lives HERE: `event.sender` is resolved
 * through the `RendererIdentityRegistry` (the same map the broker's
 * `verifyAppIdentity` trusts), and an unregistered sender is dropped before
 * the host ever sees the payload. The host then cross-checks the verified
 * app id against the pending call's target.
 */

import { ipcMain } from "electron";
import type { RendererIdentityRegistry } from "../ipc/renderer-identity";
import { type AppCallHost, type AppCallReply, TOOLS_RESULT_CHANNEL } from "./app-call-host";

export function wireAppCallIpc(host: AppCallHost, identity: RendererIdentityRegistry): void {
	ipcMain.on(TOOLS_RESULT_CHANNEL, (event, payload: AppCallReply) => {
		const appId = identity.get(event.sender.id);
		if (appId === undefined) return; // unregistered renderer — drop silently
		host.handleResult(appId, payload);
	});
}
