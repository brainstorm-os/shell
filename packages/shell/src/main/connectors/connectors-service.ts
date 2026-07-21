/**
 * Connector-2/3 — the `connectors` broker service.
 *
 * App-facing methods, each capability-checked SERVER-SIDE against the
 * active vault's ledger (the broker's declared-caps check is app-
 * controlled and bypassable — this is the authoritative gate, the same
 * posture `network-service-handler.ts` takes):
 *
 *   - `authorize({ connectorRef, externalAccountLabel })` → `{ accountId }`
 *     (Connector-2) — needs `connectors.oauth`.
 *   - `revoke({ accountId })` (Connector-2) — needs `connectors.oauth`.
 *   - `request({ accountRef, method, path, body?, headers? })` → response
 *     (Connector-3) — needs `connectors.request` AND the derived
 *     `network.connect:<origin>`; the proxy injects auth + enforces egress.
 *
 * Tokens NEVER cross this boundary: `authorize` returns only the
 * token-free account id, and `request` returns the provider response with
 * the injected `Authorization` header stripped (doc 56 §custody).
 */

import { type CapabilityLedger, LedgerUnavailableError } from "@brainstorm-os/capabilities/ledger";
import type { ServiceHandler } from "../../ipc/broker";
import type { Envelope } from "../../ipc/envelope";
import type { ConnectorRequestFn, ResolvedAccount, ResolvedConnector } from "./connectors-request";
import type { OAuthBroker } from "./oauth-broker";
import type { RedirectProvider } from "./oauth-redirect";

export const CONNECTORS_OAUTH_CAP = "connectors.oauth";
export const CONNECTORS_REQUEST_CAP = "connectors.request";

export type ConnectorsServiceDeps = {
	broker: OAuthBroker;
	redirectProvider: RedirectProvider;
	/** Resolve a `Connector` entity → provider config. */
	resolveConnector: (connectorRef: string) => Promise<ResolvedConnector | null>;
	/** Resolve a `ConnectorAccount` entity → its connector's provider config. */
	resolveAccount: (accountId: string) => Promise<ResolvedAccount | null>;
	/** Connector-3 — the auth-injecting egress proxy. */
	request: ConnectorRequestFn;
	/** Connector-4 — run a mapping's pull now (manual "Sync now" / scheduler). */
	sync?: (mappingRef: string) => Promise<unknown>;
	/** Server-side capability source; omit only in unit tests that presume
	 *  the caller is authorized (mirrors the network handler). */
	getLedger?: () => Promise<CapabilityLedger | null>;
};

function makeError(name: string, message: string): Error {
	const err = new Error(message);
	err.name = name;
	return err;
}

/** Re-check a capability against the live ledger, fail-closed. Shared by
 *  every server-side-gated broker service (connectors, mail). */
export async function requireServiceCapability(
	envelope: Envelope,
	getLedger: (() => Promise<CapabilityLedger | null>) | undefined,
	capability: string,
	service: string,
): Promise<void> {
	if (!getLedger) return;
	let ledger: CapabilityLedger | null;
	try {
		ledger = await getLedger();
	} catch (error) {
		if (error instanceof LedgerUnavailableError) {
			throw makeError("Unavailable", `${service}: capability ledger unavailable`);
		}
		throw error;
	}
	if (!ledger) throw makeError("Unavailable", `${service}: no active vault session`);
	let held: boolean;
	try {
		held = ledger.has(envelope.app, capability);
	} catch (error) {
		if (error instanceof LedgerUnavailableError) {
			throw makeError("Unavailable", `${service}: capability ledger unavailable`);
		}
		throw error;
	}
	if (!held) {
		throw makeError("Denied", `${service}.${envelope.method}: ${envelope.app} lacks ${capability}`);
	}
}

async function requireCapability(
	envelope: Envelope,
	deps: ConnectorsServiceDeps,
	capability: string,
): Promise<void> {
	await requireServiceCapability(envelope, deps.getLedger, capability, "connectors");
}

function objectArg(envelope: Envelope): Record<string, unknown> {
	const [arg] = envelope.args as [unknown];
	if (!arg || typeof arg !== "object" || Array.isArray(arg)) {
		throw makeError("Invalid", `connectors.${envelope.method}: argument must be an object`);
	}
	return arg as Record<string, unknown>;
}

function requireString(value: unknown, field: string, method: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw makeError("Invalid", `connectors.${method}: { ${field} } must be a non-empty string`);
	}
	return value;
}

export function makeConnectorsServiceHandler(deps: ConnectorsServiceDeps): ServiceHandler {
	return async (envelope: Envelope): Promise<unknown> => {
		switch (envelope.method) {
			case "authorize":
				return await handleAuthorize(envelope, deps);
			case "connectToken":
				return await handleConnectToken(envelope, deps);
			case "revoke":
				return await handleRevoke(envelope, deps);
			case "request":
				return await handleRequest(envelope, deps);
			case "sync":
				return await handleSync(envelope, deps);
			default:
				throw makeError("Invalid", `unknown connectors method: ${envelope.method}`);
		}
	};
}

async function handleAuthorize(
	envelope: Envelope,
	deps: ConnectorsServiceDeps,
): Promise<{ accountId: string }> {
	await requireCapability(envelope, deps, CONNECTORS_OAUTH_CAP);
	const arg = objectArg(envelope);
	const connectorRef = requireString(arg.connectorRef, "connectorRef", "authorize");
	const externalAccountLabel = requireString(
		arg.externalAccountLabel,
		"externalAccountLabel",
		"authorize",
	);
	const resolved = await deps.resolveConnector(connectorRef);
	if (!resolved)
		throw makeError("Invalid", `connectors.authorize: unknown connector ${connectorRef}`);
	return await deps.broker.authorize({
		connectorAppId: resolved.connectorAppId,
		connectorRef,
		externalAccountLabel,
		provider: resolved.provider,
		redirectProvider: deps.redirectProvider,
	});
}

async function handleConnectToken(
	envelope: Envelope,
	deps: ConnectorsServiceDeps,
): Promise<{ accountId: string }> {
	await requireCapability(envelope, deps, CONNECTORS_OAUTH_CAP);
	const arg = objectArg(envelope);
	const connectorRef = requireString(arg.connectorRef, "connectorRef", "connectToken");
	const externalAccountLabel = requireString(
		arg.externalAccountLabel,
		"externalAccountLabel",
		"connectToken",
	);
	const token = requireString(arg.token, "token", "connectToken");
	const resolved = await deps.resolveConnector(connectorRef);
	if (!resolved)
		throw makeError("Invalid", `connectors.connectToken: unknown connector ${connectorRef}`);
	return await deps.broker.connectWithToken({
		connectorAppId: resolved.connectorAppId,
		connectorRef,
		externalAccountLabel,
		accessToken: token,
		scopes: resolved.provider.scopes,
	});
}

async function handleSync(envelope: Envelope, deps: ConnectorsServiceDeps): Promise<unknown> {
	await requireCapability(envelope, deps, CONNECTORS_REQUEST_CAP);
	if (!deps.sync) throw makeError("Unavailable", "connectors.sync: sync engine not wired");
	const arg = objectArg(envelope);
	const mappingRef = requireString(arg.mappingRef, "mappingRef", "sync");
	return await deps.sync(mappingRef);
}

async function handleRevoke(
	envelope: Envelope,
	deps: ConnectorsServiceDeps,
): Promise<{ ok: true }> {
	await requireCapability(envelope, deps, CONNECTORS_OAUTH_CAP);
	const arg = objectArg(envelope);
	const accountId = requireString(arg.accountId, "accountId", "revoke");
	const resolved = await deps.resolveAccount(accountId);
	if (!resolved) throw makeError("Invalid", `connectors.revoke: unknown account ${accountId}`);
	await deps.broker.revoke({ connectorAppId: resolved.connectorAppId, accountId });
	return { ok: true };
}

async function handleRequest(envelope: Envelope, deps: ConnectorsServiceDeps): Promise<unknown> {
	await requireCapability(envelope, deps, CONNECTORS_REQUEST_CAP);
	const arg = objectArg(envelope);
	const accountRef = requireString(arg.accountRef, "accountRef", "request");
	const path = requireString(arg.path, "path", "request");
	const resolved = await deps.resolveAccount(accountRef);
	if (!resolved) throw makeError("Invalid", `connectors.request: unknown account ${accountRef}`);
	// Connector-3: the derived per-origin egress cap is enforced on the
	// resolved final URL inside `request` (it knows the origin); we gate the
	// umbrella `connectors.request` here.
	return await deps.request({
		envelopeApp: envelope.app,
		account: resolved,
		method: typeof arg.method === "string" ? arg.method : "GET",
		path,
		...(arg.body !== undefined ? { body: arg.body } : {}),
		...(arg.headers !== undefined ? { headers: arg.headers as Record<string, string> } : {}),
	});
}
