/**
 * Connector-3 — `connectors.request`: the auth-injecting, egress-scoped,
 * audited proxy a connector uses to talk to its provider.
 *
 * The connector calls `connectors.request({ accountRef, method, path })`;
 * this resolves the account → connector → frozen egress origins + API
 * base URL, fails closed on any out-of-scope URL (logged, never silent),
 * fetches/refreshes the Tier-2 access token through the OAuth broker,
 * injects `Authorization: Bearer`, and egresses through Net-1's
 * `executeNetworkFetch` (SSRF + size/time caps + per-host audit). The
 * provider response is returned WITHOUT the injected auth header — the
 * connector never sees the token (doc 56 §The custody invariant).
 */

import type { CapabilityLedger } from "@brainstorm-os/capabilities/ledger";
import { LedgerUnavailableError } from "@brainstorm-os/capabilities/ledger";
import { isWildcardAll, validateConnectorRequest } from "@brainstorm-os/sdk-types";
import type { ConnectorEgress } from "./egress";
import type { OAuthBroker, ProviderConfig } from "./oauth-broker";

/** A `Connector` entity resolved to its provider config + frozen scope. */
export type ResolvedConnector = {
	connectorAppId: string;
	provider: ProviderConfig;
	apiBaseUrl: string;
};

/** A `ConnectorAccount` entity resolved to its connector's config. */
export type ResolvedAccount = ResolvedConnector & {
	/** The `ConnectorAccount` entity id — the Tier-2 token key. */
	accountId: string;
	connectorRef: string;
};

export type ConnectorRequestInput = {
	/** The app that called the broker — for the per-origin egress cap check. */
	envelopeApp: string;
	account: ResolvedAccount;
	method: string;
	/** Relative path resolved against the connector's `apiBaseUrl`, or an
	 *  absolute URL (still funnelled through the one egress checkpoint). */
	path: string;
	body?: unknown;
	headers?: Record<string, string>;
};

export type ConnectorRequestResult = {
	status: number;
	headers: Record<string, string>;
	/** Response body as bytes (IPC-transcoded by the broker). */
	body: Uint8Array;
	finalUrl: string;
};

export type ConnectorRequestFn = (input: ConnectorRequestInput) => Promise<ConnectorRequestResult>;

export type ConnectorRequestDeps = {
	egress: ConnectorEgress;
	broker: OAuthBroker;
	/** Per-origin egress cap source; omit only in unit tests that presume
	 *  the caller holds the derived `network.connect:<origin>`. */
	getLedger?: () => Promise<CapabilityLedger | null>;
	/** Audit a refused request so a Denied is never silent (doc 56). */
	onRefused?: (info: { app: string; url: string; reason: string }) => void;
};

function namedError(name: string, message: string): Error {
	const err = new Error(message);
	err.name = name;
	return err;
}

/** `network.connect:<scheme>://<host>[:port]` for the final URL's origin. */
function egressCapForUrl(url: URL): string {
	return `network.connect:${url.origin}`;
}

export function makeConnectorRequest(deps: ConnectorRequestDeps): ConnectorRequestFn {
	return async (input: ConnectorRequestInput): Promise<ConnectorRequestResult> => {
		const { account } = input;
		// Reject a connector that somehow froze a wildcard origin before any
		// network reach — defense in depth over the install-time validator.
		if (account.provider.egressOrigins.some((o) => isWildcardAll(o))) {
			deps.onRefused?.({ app: input.envelopeApp, url: input.path, reason: "wildcard-origin" });
			throw namedError("Denied", "connectors.request: connector declares wildcard egress");
		}

		let finalUrl: URL;
		try {
			finalUrl = new URL(input.path, account.apiBaseUrl);
		} catch {
			throw namedError("Invalid", `connectors.request: cannot resolve path "${input.path}"`);
		}

		const decision = validateConnectorRequest(account.provider.egressOrigins, finalUrl.toString());
		if (!decision.allowed) {
			deps.onRefused?.({
				app: input.envelopeApp,
				url: finalUrl.toString(),
				reason: decision.reason,
			});
			throw namedError(
				"Denied",
				`connectors.request: ${finalUrl.toString()} is outside the connector's egress origins (${decision.reason})`,
			);
		}

		await requireEgressCap(deps, input.envelopeApp, finalUrl);

		const accessToken = await deps.broker.getValidAccessToken({
			connectorAppId: account.connectorAppId,
			accountId: account.accountId,
			provider: account.provider,
		});

		const headers = sanitizeOutboundHeaders(input.headers);
		headers.authorization = `Bearer ${accessToken}`;

		const response = await deps.egress({
			url: finalUrl.toString(),
			method: input.method,
			headers,
			...(input.body !== undefined ? { body: toBytes(input.body) } : {}),
		});

		// Never echo the injected auth header back to the connector.
		const responseHeaders: Record<string, string> = {};
		for (const [k, v] of Object.entries(response.headers)) {
			if (k.toLowerCase() === "authorization") continue;
			responseHeaders[k] = v;
		}
		return {
			status: response.status,
			headers: responseHeaders,
			body: response.body,
			finalUrl: response.finalUrl,
		};
	};
}

async function requireEgressCap(
	deps: ConnectorRequestDeps,
	app: string,
	finalUrl: URL,
): Promise<void> {
	if (!deps.getLedger) return;
	let ledger: CapabilityLedger | null;
	try {
		ledger = await deps.getLedger();
	} catch (error) {
		if (error instanceof LedgerUnavailableError) {
			throw namedError("Unavailable", "connectors.request: capability ledger unavailable");
		}
		throw error;
	}
	if (!ledger) throw namedError("Unavailable", "connectors.request: no active vault session");
	const cap = egressCapForUrl(finalUrl);
	let held: boolean;
	try {
		held = ledger.has(app, cap);
	} catch (error) {
		if (error instanceof LedgerUnavailableError) {
			throw namedError("Unavailable", "connectors.request: capability ledger unavailable");
		}
		throw error;
	}
	if (!held) {
		throw namedError("Denied", `connectors.request: ${app} lacks ${cap}`);
	}
}

/** Drop any caller-supplied Authorization (the broker owns it) + forbidden
 *  hop-by-hop headers; lower-case keys for the injection below. */
function sanitizeOutboundHeaders(
	headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(headers ?? {})) {
		const key = k.toLowerCase();
		if (key === "authorization" || key === "host" || key === "content-length") continue;
		out[key] = v;
	}
	return out;
}

function toBytes(body: unknown): Uint8Array {
	if (body instanceof Uint8Array) return body;
	if (typeof body === "string") return new TextEncoder().encode(body);
	return new TextEncoder().encode(JSON.stringify(body));
}
