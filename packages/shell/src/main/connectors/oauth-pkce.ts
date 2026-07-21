/**
 * Connector-2 — PKCE (RFC 7636) primitives for the shell OAuth broker.
 *
 * Pure + Electron-free so the Authorization-Code-with-PKCE flow is fully
 * unit-tested (the RFC 7636 Appendix-B S256 vector is pinned in the
 * test). The broker (`oauth-broker.ts`) composes these into the
 * authorize → redirect → token-exchange sequence; the connector app and
 * the renderer never see the verifier or the resulting tokens (doc 56
 * §The custody invariant).
 */

import { randomBytes } from "node:crypto";
import { sha256 } from "@brainstorm-os/native";

/** base64url (RFC 4648 §5, no padding) of raw bytes. */
function toBase64Url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

/** A high-entropy `code_verifier`: 32 random bytes → 43 base64url chars,
 *  inside the RFC 7636 43–128 range. */
export function generateCodeVerifier(): string {
	return toBase64Url(randomBytes(32));
}

/** The S256 `code_challenge` = base64url(SHA-256(ASCII(verifier))). */
export function computeCodeChallenge(codeVerifier: string): string {
	return toBase64Url(sha256(new TextEncoder().encode(codeVerifier)));
}

/** A CSRF `state` nonce bound to one authorize round-trip. */
export function generateState(): string {
	return toBase64Url(randomBytes(16));
}

export type AuthorizationUrlParams = {
	authorizeUrl: string;
	clientId: string;
	redirectUri: string;
	scopes: readonly string[];
	state: string;
	codeChallenge: string;
	/** Extra provider-specific query params (e.g. `access_type=offline`). */
	extraParams?: Readonly<Record<string, string>>;
};

/**
 * Build the provider authorization URL (Auth-Code + PKCE, S256). The
 * caller validates `authorizeUrl` against the connector's frozen egress
 * origins before opening it.
 */
export function buildAuthorizationUrl(params: AuthorizationUrlParams): string {
	const url = new URL(params.authorizeUrl);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", params.clientId);
	url.searchParams.set("redirect_uri", params.redirectUri);
	url.searchParams.set("scope", params.scopes.join(" "));
	url.searchParams.set("state", params.state);
	url.searchParams.set("code_challenge", params.codeChallenge);
	url.searchParams.set("code_challenge_method", "S256");
	for (const [k, v] of Object.entries(params.extraParams ?? {})) {
		url.searchParams.set(k, v);
	}
	return url.toString();
}
