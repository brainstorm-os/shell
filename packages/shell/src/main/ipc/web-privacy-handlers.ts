/**
 * `web-privacy:*` IPC handlers — the dashboard renderer's read/revoke
 * surface over the Browser-7 web-privacy runtime (per-site device-permission
 * grants + the browser engine's per-host egress aggregate) for
 * Settings → Privacy.
 *
 * **Privileged-only**: dashboard-bound `ipcMain.handle` channels, never the
 * broker (the `network-settings-handlers` pattern). The Browser app itself
 * reaches the grant store only through the broker's `webview` service,
 * gated on `web.browse`.
 */

import {
	WEB_EGRESS_SUMMARY_CHANNEL,
	WEB_SITE_PERMISSIONS_LIST_CHANNEL,
	WEB_SITE_PERMISSIONS_REVOKE_CHANNEL,
	WEB_SITE_TRUST_LIST_CHANNEL,
	WEB_SITE_TRUST_REVOKE_CHANNEL,
	WEB_SITE_TRUST_SET_CHANNEL,
} from "@brainstorm-os/protocol/web-privacy-wire-types";
import { ipcMain } from "electron";
import { webOriginOf } from "../web/site-permissions";
import type { WebPrivacyRuntime } from "../web/web-privacy-runtime";

export function registerWebPrivacyHandlers(runtime: WebPrivacyRuntime): void {
	ipcMain.handle(WEB_SITE_PERMISSIONS_LIST_CHANNEL, async () => runtime.permissions.list());
	ipcMain.handle(WEB_SITE_PERMISSIONS_REVOKE_CHANNEL, async (_event, origin: unknown) => {
		if (typeof origin !== "string" || origin.length === 0) return false;
		return runtime.permissions.revokeOrigin(origin);
	});
	ipcMain.handle(WEB_EGRESS_SUMMARY_CHANNEL, async (_event, limit: unknown) =>
		runtime.egress.summary(typeof limit === "number" ? limit : undefined),
	);

	// Browser-8 — per-site trust. Set canonicalizes + validates the origin
	// (`webOriginOf` rejects bare hosts / non-http(s)) so only a real web origin
	// is ever stored; a bad input is a no-op, never a persisted junk row.
	ipcMain.handle(WEB_SITE_TRUST_LIST_CHANNEL, async () => runtime.trust.list());
	ipcMain.handle(
		WEB_SITE_TRUST_SET_CHANNEL,
		async (_event, origin: unknown, trusted: unknown): Promise<boolean> => {
			if (typeof origin !== "string" || typeof trusted !== "boolean") return false;
			const canonical = webOriginOf(origin);
			if (!canonical) return false;
			await runtime.trust.set(canonical, trusted);
			return true;
		},
	);
	ipcMain.handle(WEB_SITE_TRUST_REVOKE_CHANNEL, async (_event, origin: unknown) => {
		if (typeof origin !== "string" || origin.length === 0) return false;
		return runtime.trust.revokeOrigin(origin);
	});
}
