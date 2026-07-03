/**
 * 14.6 — billing-edge transport binding (Electron-bound `net.fetch`, like
 * `update-feed-fetch.ts`). The pure request/response contract lives in
 * `billing-edge-client.ts`, which is where the tests are.
 *
 * The base URLs are build-time constants with env overrides for dev /
 * staging (the cloud stack runs billing-edge on 127.0.0.1:8787 and the
 * account portal on :3001 locally). The production hosts are wired alongside
 * the cloud deploy — same posture as `DEFAULT_UPDATE_FEED_URL`.
 */

import { net } from "electron";
import type { BillingEdgePostJson } from "./billing-edge-client";

/** Default billing-edge origin. Override with `BRAINSTORM_BILLING_EDGE_URL`. */
export const DEFAULT_BILLING_EDGE_URL = "https://api.brainstorm.app";

/** Default account-portal origin (the Next.js `apps/account` control-plane
 *  portal). Override with `BRAINSTORM_ACCOUNT_PORTAL_URL`. */
export const DEFAULT_ACCOUNT_PORTAL_URL = "https://account.brainstorm.app";

const FETCH_TIMEOUT_MS = 10_000;

export function billingEdgeBaseUrl(): string {
	return process.env.BRAINSTORM_BILLING_EDGE_URL ?? DEFAULT_BILLING_EDGE_URL;
}

export function accountPortalUrl(): string {
	return process.env.BRAINSTORM_ACCOUNT_PORTAL_URL ?? DEFAULT_ACCOUNT_PORTAL_URL;
}

/** POST JSON to billing-edge. `null` on any transport failure so the client
 *  degrades to `Offline`, never throws. */
export function makeBillingEdgePostJson(baseUrl: string): BillingEdgePostJson {
	return async (path, body) => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		try {
			const response = await net.fetch(new URL(path, baseUrl).toString(), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			let json: unknown;
			try {
				json = await response.json();
			} catch {
				json = undefined;
			}
			return { status: response.status, json };
		} catch (_error) {
			return null;
		} finally {
			clearTimeout(timer);
		}
	};
}
