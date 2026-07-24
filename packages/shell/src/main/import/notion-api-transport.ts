/**
 * IE-7 rung 4a — binding the Notion API client to real network + real secrets.
 *
 * Two custody rules shape this file:
 *  - **the token never leaves main.** It is stored in the vault's Tier-2
 *    credential store (encrypted under the master key) and injected as an
 *    `Authorization` header here; the renderer sends it in ONCE at connect time
 *    and never receives it back (the same posture as the connector broker's
 *    OAuth tokens, doc 56 §The custody invariant).
 *  - **every request rides Net-1.** `makeNetworkEgress` funnels each call
 *    through `executeNetworkFetch`, so the SSRF guard, size/time caps and the
 *    per-host audit log all apply, and Settings → Privacy → Network attributes
 *    the traffic to this importer rather than to "the app".
 *
 * The paperwork-gated OAuth flow (a registered public Notion integration, the
 * Mailbox-9 analogue) can replace {@link notionTokenFromStore} without touching
 * the client or the Source: both only ever see a `NotionTransport`.
 */

import { makeNetworkEgress } from "../connectors/egress";
import type { CredentialKey } from "../credentials/store";
import type { ExecuteOptions } from "../network/network-service";
import { NOTION_API_VERSION, type NotionTransport } from "./notion-api-client";

/** Audit/attribution id for Notion-import traffic. */
export const NOTION_IMPORT_APP_ID = "io.brainstorm.import.notion";

/** Where the workspace token lives in the vault credential store. */
export const NOTION_CREDENTIAL: CredentialKey = {
	app: NOTION_IMPORT_APP_ID,
	key: "api-token",
};

const NOTION_API_ORIGIN = "https://api.notion.com";

/** The minimal session surface this module needs (keeps it unit-testable). */
export type NotionCredentialSession = {
	getCredential(target: CredentialKey): Promise<Uint8Array | null>;
	setCredential(target: CredentialKey, value: Uint8Array): Promise<void>;
	deleteCredential(target: CredentialKey): Promise<boolean>;
};

export async function storeNotionToken(
	session: NotionCredentialSession,
	token: string,
): Promise<void> {
	await session.setCredential(NOTION_CREDENTIAL, new TextEncoder().encode(token.trim()));
}

export async function clearNotionToken(session: NotionCredentialSession): Promise<boolean> {
	return session.deleteCredential(NOTION_CREDENTIAL);
}

/** The stored token, or null when the workspace was never connected. */
export async function notionTokenFromStore(
	session: NotionCredentialSession,
): Promise<string | null> {
	const bytes = await session.getCredential(NOTION_CREDENTIAL);
	if (!bytes || bytes.length === 0) return null;
	const token = new TextDecoder().decode(bytes).trim();
	return token.length > 0 ? token : null;
}

/**
 * Build the transport the client + Source run on. Relative paths resolve
 * against Notion's API origin ONLY — an absolute URL from anywhere else is
 * refused here rather than handed to the fetcher, so a future caller can't turn
 * this authenticated transport (it carries the user's token) into a general
 * egress for another host.
 */
export function makeNotionTransport(opts: {
	token: string;
	executeOptions: ExecuteOptions;
}): NotionTransport {
	const egress = makeNetworkEgress({
		executeOptions: opts.executeOptions,
		appId: NOTION_IMPORT_APP_ID,
	});
	return async ({ method, path, body }) => {
		const url = new URL(path, NOTION_API_ORIGIN);
		if (url.origin !== NOTION_API_ORIGIN) {
			throw new Error(`notion: refusing off-origin request to ${url.origin}`);
		}
		const response = await egress({
			url: url.toString(),
			method,
			headers: {
				Authorization: `Bearer ${opts.token}`,
				"Notion-Version": NOTION_API_VERSION,
				...(body === undefined ? {} : { "Content-Type": "application/json" }),
			},
			...(body === undefined ? {} : { body: new TextEncoder().encode(JSON.stringify(body)) }),
		});
		let json: unknown = null;
		try {
			const text = new TextDecoder().decode(response.body);
			json = text.length > 0 ? JSON.parse(text) : null;
		} catch {
			json = null; // A non-JSON body is reported through the status alone.
		}
		return { status: response.status, json };
	};
}
