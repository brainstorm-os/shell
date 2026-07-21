/**
 * Browser-7 — wire types shared between the main-process web-privacy
 * runtime, the dashboard preload, and the Settings → Privacy renderer
 * (the `network-wire-types.ts` pattern: one module, no Electron imports,
 * importable from every layer).
 *
 * Privileged-only surface: the channels are dashboard-bound
 * `ipcMain.handle` routes (apps never see them — an app reaches the
 * grant store only through the broker's `webview` service, gated on
 * `web.browse`).
 */

import type { SitePermissionKind } from "@brainstorm-os/sdk-types";

/** One persisted per-origin device-permission decision. `allow: false` is an
 *  explicit block (the chrome stops asking); absence of a grant is the
 *  deny-default (the chrome may surface the ask banner). */
export type SitePermissionGrant = {
	/** `https://example.com` — a serialized web origin, never a bare host. */
	readonly origin: string;
	readonly permission: SitePermissionKind;
	readonly allow: boolean;
	/** Wall-clock ms of the last decision change. */
	readonly updatedAt: number;
};

/** Browser-8 — one persisted per-origin TRUST decision ("compatibility mode").
 *  The strict privacy posture (third-party-cookie block + tracker blocklist) is
 *  the default; trusting an origin relaxes BOTH for pages whose FIRST PARTY is
 *  that origin — the escape hatch for login-gated SPAs (x.com etc.) whose SSO /
 *  scripts the strict defaults break. Absence of a grant = strict (the default).
 *  Never softens the global default; opt-in per site only. */
export type SiteTrustGrant = {
	/** `https://x.com` — a serialized web origin, never a bare host. */
	readonly origin: string;
	/** `true` relaxes the 3p-cookie strip + tracker blocklist for this first
	 *  party. (Only `true` is persisted — untrusting deletes the row.) */
	readonly trusted: boolean;
	/** Wall-clock ms of the last decision change. */
	readonly updatedAt: number;
};

/** Per-host aggregate of the browser engine's page egress (subresource
 *  requests observed by the locked session — metadata only, no URLs/paths). */
export type WebEgressHostSummary = {
	readonly host: string;
	/** Requests that went to the network. */
	readonly count: number;
	/** Requests cancelled by the tracker/ad blocklist. */
	readonly blockedCount: number;
	readonly lastSeenMs: number;
};

export const WEB_SITE_PERMISSIONS_LIST_CHANNEL = "web-privacy:site-permissions:list";
export const WEB_SITE_PERMISSIONS_REVOKE_CHANNEL = "web-privacy:site-permissions:revoke";
export const WEB_EGRESS_SUMMARY_CHANNEL = "web-privacy:egress:summary";
export const WEB_SITE_TRUST_LIST_CHANNEL = "web-privacy:site-trust:list";
export const WEB_SITE_TRUST_SET_CHANNEL = "web-privacy:site-trust:set";
export const WEB_SITE_TRUST_REVOKE_CHANNEL = "web-privacy:site-trust:revoke";
