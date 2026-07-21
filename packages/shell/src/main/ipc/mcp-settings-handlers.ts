/**
 * MCP settings privileged IPC (doc 64 §Settings UI — MCP-3).
 *
 * The dashboard (privileged renderer, not a sandboxed app) manages MCP server
 * config here via direct ipcMain — NOT the broker (it isn't an app). Mirrors the
 * AI provider-key surface: the auth secret is write-only across this boundary
 * (`setAuth` seals it into the active vault's Tier-2 store; `has*` returns only a
 * boolean; the raw secret is NEVER returned to any renderer). The server config
 * record (per-vault, syncs) + per-device enablement live in `mcp-config-store`.
 *
 * The tools inspector (`inspect`) connects to a server, discovers its tools, and
 * returns them with their UNTRUSTED descriptions + annotations verbatim (the UI
 * marks them untrusted) AND a rug-pull flag per tool (changed/new since the
 * device-local approval baseline) so the panel can surface "review changes".
 * `approve` re-baselines the approved fingerprints (clears the rug-pull flag).
 */

import {
	type McpRugPullKind,
	type McpServerConfig,
	type McpToolDescriptor,
	McpTransportKind,
	detectRugPull,
	fingerprintTools,
	isValidMcpServerId,
	isValidStdioArgs,
	isValidStdioCommand,
} from "@brainstorm-os/sdk-types";
import { ipcMain } from "electron";
import {
	deleteMcpServerAuth,
	readMcpServerAuth,
	writeMcpServerAuth,
} from "../credentials/mcp-server-auth";
import {
	type McpServerView,
	type UpsertMcpServerInput,
	getApprovedFingerprints,
	getMcpServer,
	listMcpServers,
	removeMcpServer,
	setApprovedFingerprints,
	setMcpServerEnabled,
	upsertMcpServer,
} from "../mcp/mcp-config-store";
import { connectMcpServer } from "../mcp/mcp-connect";
import { nodeStdioSpawn } from "../mcp/mcp-stdio-spawn";
import type { McpFetchJson } from "../mcp/mcp-transport";
import { getActiveVaultSession } from "../vault/session";

export const MCP_LIST_CHANNEL = "mcp-settings:list" as const;
export const MCP_UPSERT_CHANNEL = "mcp-settings:upsert" as const;
export const MCP_REMOVE_CHANNEL = "mcp-settings:remove" as const;
export const MCP_SET_ENABLED_CHANNEL = "mcp-settings:set-enabled" as const;
export const MCP_HAS_AUTH_CHANNEL = "mcp-settings:has-auth" as const;
export const MCP_SET_AUTH_CHANNEL = "mcp-settings:set-auth" as const;
export const MCP_CLEAR_AUTH_CHANNEL = "mcp-settings:clear-auth" as const;
export const MCP_INSPECT_CHANNEL = "mcp-settings:inspect" as const;
export const MCP_APPROVE_CHANNEL = "mcp-settings:approve" as const;

export type McpSettingsHandlerDeps = {
	/** The HTTP seam for the tools inspector — production binds it to
	 *  `executeNetworkFetch`. */
	readonly fetchJson: McpFetchJson;
};

/** One tool in the inspector view: the (UNTRUSTED, verbatim) descriptor plus its
 *  rug-pull status against the device-local approval baseline. */
export type McpInspectedTool = McpToolDescriptor & {
	/** "changed" / "new" since approval, or null when it matches the baseline. */
	readonly rugPull: McpRugPullKind | null;
};

export type McpInspectResult = {
	/** Connected + discovered. */
	readonly ok: boolean;
	/** Tools with rug-pull status, or [] when down/unreachable. */
	readonly tools: readonly McpInspectedTool[];
	/** A short reason when `ok` is false (down / no-server / stdio). */
	readonly reason?: string;
};

function activeVaultPath(): string | null {
	return getActiveVaultSession()?.vaultPath ?? null;
}

function validateUpsert(value: unknown): UpsertMcpServerInput | null {
	if (!value || typeof value !== "object") return null;
	const r = value as Record<string, unknown>;
	if (!isValidMcpServerId(r.id)) return null;
	if (typeof r.name !== "string" || r.name.trim().length === 0) return null;
	const base = { id: r.id, name: r.name.trim(), requiresAuth: r.requiresAuth === true };

	// stdio (MCP-2): a local command + optional argv, no URL. The actual SPAWN is
	// still gated on the scarce `mcp.spawn-local` cap at call time; configuring
	// one here is harmless until granted + enabled.
	if (r.transport === McpTransportKind.Stdio) {
		if (!isValidStdioCommand(r.command)) return null;
		const args = r.args === undefined ? [] : r.args;
		if (!isValidStdioArgs(args)) return null;
		return { ...base, transport: McpTransportKind.Stdio, command: r.command, args: [...args] };
	}

	// HTTP transports require a URL.
	const transport =
		r.transport === McpTransportKind.StreamableHttp || r.transport === McpTransportKind.Sse
			? r.transport
			: null;
	if (!transport) return null;
	if (typeof r.url !== "string" || r.url.length === 0) return null;
	return { ...base, transport, url: r.url };
}

export function registerMcpSettingsHandlers(deps: McpSettingsHandlerDeps): void {
	ipcMain.handle(MCP_LIST_CHANNEL, async (): Promise<readonly McpServerView[]> => {
		const vaultPath = activeVaultPath();
		return vaultPath ? listMcpServers(vaultPath) : [];
	});

	ipcMain.handle(
		MCP_UPSERT_CHANNEL,
		async (_event, input: unknown): Promise<McpServerConfig | null> => {
			const vaultPath = activeVaultPath();
			const validated = validateUpsert(input);
			if (!vaultPath || !validated) return null;
			return upsertMcpServer(vaultPath, validated);
		},
	);

	ipcMain.handle(MCP_REMOVE_CHANNEL, async (_event, serverId: unknown): Promise<boolean> => {
		const vaultPath = activeVaultPath();
		if (!vaultPath || !isValidMcpServerId(serverId)) return false;
		// Drop the auth secret too — removing a server forgets its credential.
		const session = getActiveVaultSession();
		if (session) await deleteMcpServerAuth(session.credentials, serverId).catch(() => {});
		return removeMcpServer(vaultPath, serverId);
	});

	ipcMain.handle(
		MCP_SET_ENABLED_CHANNEL,
		async (_event, serverId: unknown, enabled: unknown): Promise<boolean> => {
			const vaultPath = activeVaultPath();
			if (!vaultPath || !isValidMcpServerId(serverId) || typeof enabled !== "boolean") return false;
			return setMcpServerEnabled(vaultPath, serverId, enabled);
		},
	);

	ipcMain.handle(MCP_HAS_AUTH_CHANNEL, async (_event, serverId: unknown): Promise<boolean> => {
		const session = getActiveVaultSession();
		if (!session || !isValidMcpServerId(serverId)) return false;
		return (await readMcpServerAuth(session.credentials, serverId)) !== null;
	});

	ipcMain.handle(
		MCP_SET_AUTH_CHANNEL,
		async (_event, serverId: unknown, secret: unknown): Promise<boolean> => {
			const session = getActiveVaultSession();
			if (!session || !isValidMcpServerId(serverId)) return false;
			if (typeof secret !== "string" || secret.trim().length === 0) return false;
			await writeMcpServerAuth(session.credentials, serverId, secret.trim());
			return true;
		},
	);

	ipcMain.handle(MCP_CLEAR_AUTH_CHANNEL, async (_event, serverId: unknown): Promise<boolean> => {
		const session = getActiveVaultSession();
		if (!session || !isValidMcpServerId(serverId)) return false;
		return deleteMcpServerAuth(session.credentials, serverId);
	});

	// Tools inspector — connect, discover, mark untrusted + rug-pull status.
	ipcMain.handle(
		MCP_INSPECT_CHANNEL,
		async (_event, serverId: unknown): Promise<McpInspectResult> => {
			const vaultPath = activeVaultPath();
			if (!vaultPath || !isValidMcpServerId(serverId)) {
				return { ok: false, tools: [], reason: "no-vault" };
			}
			const servers = await listMcpServers(vaultPath);
			const server = servers.find((s) => s.id === serverId) ?? null;
			if (!server) return { ok: false, tools: [], reason: "no-server" };
			const connection = await connectMcpServer(server, {
				fetchJson: deps.fetchJson,
				getCredentialStore: () => getActiveVaultSession()?.credentials ?? null,
				spawn: nodeStdioSpawn,
			}).catch(() => null);
			if (!connection) return { ok: false, tools: [], reason: "no-command-or-url" };
			const tools = await connection.listTools().catch(() => null);
			if (!tools) return { ok: false, tools: [], reason: "down" };
			const approved = await getApprovedFingerprints(vaultPath, serverId);
			const rugPulls = detectRugPull(tools, approved);
			const rugByTool = new Map(rugPulls.map((r) => [r.toolName, r.kind] as const));
			return {
				ok: true,
				tools: tools.map((tool) => ({ ...tool, rugPull: rugByTool.get(tool.name) ?? null })),
			};
		},
	);

	// Approve the current tool surface — re-baselines the device-local
	// fingerprints so the rug-pull flags clear (and future calls of THIS surface
	// don't re-prompt). Returns false when the server can't be reached.
	ipcMain.handle(MCP_APPROVE_CHANNEL, async (_event, serverId: unknown): Promise<boolean> => {
		const vaultPath = activeVaultPath();
		if (!vaultPath || !isValidMcpServerId(serverId)) return false;
		const config = await getMcpServer(vaultPath, serverId);
		if (!config) return false;
		const servers = await listMcpServers(vaultPath);
		const server = servers.find((s) => s.id === serverId);
		if (!server) return false;
		const connection = await connectMcpServer(server, {
			fetchJson: deps.fetchJson,
			getCredentialStore: () => getActiveVaultSession()?.credentials ?? null,
			spawn: nodeStdioSpawn,
		}).catch(() => null);
		if (!connection) return false;
		const tools = await connection.listTools().catch(() => null);
		if (!tools) return false;
		await setApprovedFingerprints(vaultPath, serverId, fingerprintTools(tools));
		return true;
	});
}
