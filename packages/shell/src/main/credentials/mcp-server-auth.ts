/**
 * MCP server auth secrets as Tier-2 shell credentials (doc 64 §credential
 * custody — MCP-1).
 *
 * A remote MCP server may require an auth secret (a bearer token). Per the
 * credential-routing rule (CLAUDE.md — only `main/credentials/` names the
 * credential keyspace) and doc 64 ("MCP server auth secrets are a new Tier-2
 * credential class, same custody as AI provider keys"), the secret is owned by
 * the shell: stored in the per-vault `CredentialStore` (sealed under the vault
 * master key, encrypted at rest), read only by the main-process broker at
 * request time when it frames the `Authorization` header, and **never crossing
 * IPC to a sandboxed app or renderer**. The Settings MCP panel sets/clears it
 * write-only (mirroring the AI provider-key surface); `has` returns a boolean.
 *
 * This module is the one place that names the credential key; the MCP broker +
 * the Settings MCP handlers go through these helpers.
 */

import { mcpServerCredentialKeyName } from "@brainstorm-os/sdk-types";
import type { CredentialKey, CredentialStore } from "./store";

/** The credential `app` namespace for shell-owned MCP server auth secrets.
 *  Parallel to the AI providers' `io.brainstorm.ai`. */
const MCP_APP = "io.brainstorm.mcp";

/** The `CredentialStore` key for a given server's auth secret. */
export function mcpServerCredentialKey(serverId: string): CredentialKey {
	return { app: MCP_APP, key: mcpServerCredentialKeyName(serverId) };
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/** Read a server's stored auth secret, or `null` when none is configured. */
export async function readMcpServerAuth(
	store: CredentialStore,
	serverId: string,
): Promise<string | null> {
	const bytes = await store.get(mcpServerCredentialKey(serverId));
	if (!bytes) return null;
	const secret = DECODER.decode(bytes).trim();
	return secret.length > 0 ? secret : null;
}

/** Store (or replace) a server's auth secret. The value is sealed at rest by
 *  the `CredentialStore`; only the main-process broker reads it back. */
export async function writeMcpServerAuth(
	store: CredentialStore,
	serverId: string,
	secret: string,
): Promise<void> {
	await store.set(mcpServerCredentialKey(serverId), ENCODER.encode(secret));
}

/** Remove a server's stored auth secret. Returns false when none was set. */
export async function deleteMcpServerAuth(
	store: CredentialStore,
	serverId: string,
): Promise<boolean> {
	return store.delete(mcpServerCredentialKey(serverId));
}
