/**
 * Production binding for the MCP broker's `connect` seam (MCP-1).
 *
 * Turns a configured + enabled {@link McpServerView} into an {@link McpConnection}
 * the `mcp` service uses to discover + call. This is the ONE place the auth
 * secret is touched: resolved main-only from the Tier-2 credential store, framed
 * into the `Authorization: Bearer` header, and closed over by the connection —
 * it NEVER crosses IPC and never appears in the audit log. The HTTP transport
 * (over the egress broker) does the SSRF / size / time / audit / per-origin
 * egress work; this binding only carries the routing + the secret.
 *
 * HTTP servers connect over the egress broker; stdio servers (MCP-2) spawn a
 * local child via the injected {@link McpConnectDeps.spawn} seam — the broker
 * has already re-checked `mcp.spawn-local` + `mcp.server:<id>` against the
 * ledger before connect is called. Returns null when the server can't be
 * connected (HTTP missing URL / stdio missing command / no spawn seam) — those
 * servers are treated as unavailable (their tools drop out), never silently
 * called.
 */

import { isHttpMcpTransport, isStdioMcpTransport } from "@brainstorm-os/sdk-types";
import { readMcpServerAuth } from "../credentials/mcp-server-auth";
import type { CredentialStore } from "../credentials/store";
import type { McpServerView } from "./mcp-config-store";
import type { McpConnection } from "./mcp-service";
import { type StdioSpawn, callToolStdio, discoverToolsStdio } from "./mcp-stdio-transport";
import { type McpFetchJson, callTool, discoverTools } from "./mcp-transport";

export type McpConnectDeps = {
	/** The HTTP seam — production binds it to `executeNetworkFetch`. */
	readonly fetchJson: McpFetchJson;
	/** The active vault's credential store (Tier-2 auth secret), or null. */
	readonly getCredentialStore: () => CredentialStore | null;
	/** The stdio spawn seam (MCP-2) — production binds it to `child_process.spawn`
	 *  with `shell:false`. Absent → stdio servers are unavailable. */
	readonly spawn?: StdioSpawn;
};

/** Build a connection to one server, resolving its auth secret main-only.
 *  Returns null when the server can't be connected. */
export async function connectMcpServer(
	server: McpServerView,
	deps: McpConnectDeps,
): Promise<McpConnection | null> {
	if (isStdioMcpTransport(server.transport)) {
		if (!deps.spawn || !server.command) return null;
		const spawn = deps.spawn;
		const command = server.command;
		const args = server.args ?? [];
		return {
			listTools: () => discoverToolsStdio(spawn, command, args),
			callTool: (toolName, toolArgs) => callToolStdio(spawn, command, args, toolName, toolArgs),
		};
	}
	if (!isHttpMcpTransport(server.transport) || !server.url) return null;
	const url = server.url;

	// Resolve the auth secret ONCE per connection, main-only. The header is
	// closed over — it never leaves this module's scope.
	const authHeader = await resolveAuthHeader(server, deps);

	return {
		listTools: () => discoverTools(deps.fetchJson, url, authHeader),
		callTool: (toolName, args) => callTool(deps.fetchJson, url, authHeader, toolName, args),
	};
}

async function resolveAuthHeader(
	server: McpServerView,
	deps: McpConnectDeps,
): Promise<Readonly<Record<string, string>>> {
	if (!server.requiresAuth) return {};
	const store = deps.getCredentialStore();
	if (!store) return {};
	const secret = await readMcpServerAuth(store, server.id);
	return secret ? { Authorization: `Bearer ${secret}` } : {};
}
