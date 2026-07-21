/**
 * MCP server config persistence (doc 64 §config — MCP-1, OQ-MCP-1).
 *
 * Two stores, two scopes — this is the OQ-MCP-1 position:
 *
 *  1. The per-vault server config RECORD (`<vault>/shell/mcp-servers.json`).
 *     The server DEFINITION (id, name, transport, url, requiresAuth) syncs
 *     across the user's devices like other vault settings. Holds NO secret —
 *     the auth token lives in the Tier-2 credential store (mcp-server-auth.ts).
 *
 *  2. The per-DEVICE enablement + rug-pull baseline
 *     (`<vault>/shell/mcp-enablement.local.json`). Whether a server is enabled /
 *     reachable is decided per device (an HTTP server may be reachable here but
 *     not there); the `.local.` infix marks it as NON-synced device state. The
 *     approved-tool fingerprints (the rug-pull baseline, doc 64 §Prompt
 *     injection) live here too: approval is a local act on a local device, so
 *     the rug-pull comparison is device-local.
 *
 * Pure I/O, default-on-first-read (a missing/corrupt file returns + rewrites the
 * default). NON-secret only. Mirrors the `ai-settings-store` / `app-lock-settings`
 * `shell/`-convention pattern.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	type McpApprovedFingerprints,
	type McpServerConfig,
	McpTransportKind,
	isHttpMcpTransport,
	isValidMcpServerId,
	isValidStdioArgs,
	isValidStdioCommand,
} from "@brainstorm-os/sdk-types";

export const MCP_SERVERS_FILENAME = "mcp-servers.json";
export const MCP_ENABLEMENT_FILENAME = "mcp-enablement.local.json";

/** Hard cap on configured servers — bounds the surface + the UI. */
export const MAX_MCP_SERVERS = 64;

/** The synced server config record (per-vault). */
type ServersFile = {
	v: 1;
	servers: Record<string, McpServerConfig>;
};

/** The per-device enablement + rug-pull baseline (NOT synced). */
type EnablementFile = {
	v: 1;
	/** serverId → enabled-on-this-device. Absent = disabled (fail-closed). */
	enabled: Record<string, boolean>;
	/** serverId → the approved tool fingerprints at last review (rug-pull
	 *  baseline). Absent = nothing approved yet (everything is "new"). */
	approved: Record<string, McpApprovedFingerprints>;
};

function serversPath(vaultPath: string): string {
	return join(vaultPath, "shell", MCP_SERVERS_FILENAME);
}

function enablementPath(vaultPath: string): string {
	return join(vaultPath, "shell", MCP_ENABLEMENT_FILENAME);
}

function isTransport(value: unknown): value is McpTransportKind {
	return (
		value === McpTransportKind.StreamableHttp ||
		value === McpTransportKind.Sse ||
		value === McpTransportKind.Stdio
	);
}

/** Validate one raw server record. Returns null (dropped) on any malformation —
 *  fail-closed: a hand-edited / sync-corrupted entry never becomes a live
 *  server. An HTTP transport REQUIRES a parseable URL. */
function validateServer(value: unknown): McpServerConfig | null {
	if (!value || typeof value !== "object") return null;
	const r = value as Record<string, unknown>;
	if (!isValidMcpServerId(r.id)) return null;
	if (typeof r.name !== "string" || r.name.trim().length === 0) return null;
	if (!isTransport(r.transport)) return null;
	const requiresAuth = r.requiresAuth === true;
	const now = Date.now();
	const createdAt = typeof r.createdAt === "number" && r.createdAt > 0 ? r.createdAt : now;
	const updatedAt = typeof r.updatedAt === "number" && r.updatedAt > 0 ? r.updatedAt : createdAt;
	const base = {
		id: r.id,
		name: r.name.trim(),
		transport: r.transport,
		requiresAuth,
		createdAt,
		updatedAt,
	};
	if (isHttpMcpTransport(r.transport)) {
		if (typeof r.url !== "string") return null;
		try {
			// Reject non-http(s) schemes at config time (defense in depth — the
			// egress SSRF floor also rejects them at fetch, but a file:/data: URL
			// should never enter config in the first place).
			const scheme = new URL(r.url).protocol;
			if (scheme !== "http:" && scheme !== "https:") return null;
		} catch {
			return null;
		}
		return { ...base, url: r.url };
	}
	// stdio (MCP-2): REQUIRES a valid command; args optional. Fail-closed — a
	// record without a spawnable command never becomes a live server.
	if (!isValidStdioCommand(r.command)) return null;
	const args = r.args === undefined ? [] : r.args;
	if (!isValidStdioArgs(args)) return null;
	return { ...base, command: r.command, args: [...args] };
}

async function readServersFile(vaultPath: string): Promise<ServersFile> {
	try {
		const raw = await readFile(serversPath(vaultPath), "utf8");
		const parsed = JSON.parse(raw) as Partial<ServersFile>;
		const servers: Record<string, McpServerConfig> = {};
		if (parsed?.servers && typeof parsed.servers === "object") {
			for (const value of Object.values(parsed.servers)) {
				const valid = validateServer(value);
				if (valid) servers[valid.id] = valid;
			}
		}
		return { v: 1, servers };
	} catch {
		return { v: 1, servers: {} };
	}
}

async function writeServersFile(vaultPath: string, file: ServersFile): Promise<void> {
	const path = serversPath(vaultPath);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

async function readEnablementFile(vaultPath: string): Promise<EnablementFile> {
	try {
		const raw = await readFile(enablementPath(vaultPath), "utf8");
		const parsed = JSON.parse(raw) as Partial<EnablementFile>;
		const enabled: Record<string, boolean> = {};
		const approved: Record<string, McpApprovedFingerprints> = {};
		if (parsed?.enabled && typeof parsed.enabled === "object") {
			for (const [id, on] of Object.entries(parsed.enabled)) {
				if (isValidMcpServerId(id) && typeof on === "boolean") enabled[id] = on;
			}
		}
		if (parsed?.approved && typeof parsed.approved === "object") {
			for (const [id, fps] of Object.entries(parsed.approved)) {
				if (isValidMcpServerId(id) && fps && typeof fps === "object") {
					const clean: Record<string, string> = {};
					for (const [tool, fp] of Object.entries(fps as Record<string, unknown>)) {
						if (typeof fp === "string") clean[tool] = fp;
					}
					approved[id] = clean;
				}
			}
		}
		return { v: 1, enabled, approved };
	} catch {
		return { v: 1, enabled: {}, approved: {} };
	}
}

async function writeEnablementFile(vaultPath: string, file: EnablementFile): Promise<void> {
	const path = enablementPath(vaultPath);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

/** A server config + its per-device live state (enablement + approved baseline)
 *  — the shape the Settings panel + the broker read. */
export type McpServerView = McpServerConfig & {
	/** Enabled on THIS device (per-device, fail-closed default false). */
	readonly enabledHere: boolean;
};

/** List all configured servers (per-vault record) with their per-device
 *  enablement merged in. Sorted by name for a stable UI. */
export async function listMcpServers(vaultPath: string): Promise<McpServerView[]> {
	const [servers, enablement] = await Promise.all([
		readServersFile(vaultPath),
		readEnablementFile(vaultPath),
	]);
	return Object.values(servers.servers)
		.map((config) => ({ ...config, enabledHere: enablement.enabled[config.id] === true }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** Read one server's config record (no per-device state). */
export async function getMcpServer(
	vaultPath: string,
	serverId: string,
): Promise<McpServerConfig | null> {
	const servers = await readServersFile(vaultPath);
	return servers.servers[serverId] ?? null;
}

export type UpsertMcpServerInput = {
	readonly id: string;
	readonly name: string;
	readonly transport: McpTransportKind;
	readonly url?: string;
	/** stdio transport: the executable to spawn + its argv (verbatim, shell:false). */
	readonly command?: string;
	readonly args?: readonly string[];
	readonly requiresAuth: boolean;
};

/** Add or replace a server in the per-vault record. Returns the validated
 *  stored config, or null when the input is invalid / the cap is hit on a NEW
 *  id. Preserves `createdAt` on replace. */
export async function upsertMcpServer(
	vaultPath: string,
	input: UpsertMcpServerInput,
): Promise<McpServerConfig | null> {
	const file = await readServersFile(vaultPath);
	const existing = file.servers[input.id];
	if (!existing && Object.keys(file.servers).length >= MAX_MCP_SERVERS) return null;
	const now = Date.now();
	const candidate = validateServer({
		...input,
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
	});
	if (!candidate) return null;
	file.servers[candidate.id] = candidate;
	await writeServersFile(vaultPath, file);
	return candidate;
}

/** Remove a server from the per-vault record AND its per-device state (doc 64:
 *  removing a server closes the connection and revokes its grants — grant
 *  revocation is the ledger's job; here we drop config + enablement + baseline).
 *  Returns false when no such server existed. */
export async function removeMcpServer(vaultPath: string, serverId: string): Promise<boolean> {
	const file = await readServersFile(vaultPath);
	if (!(serverId in file.servers)) return false;
	delete file.servers[serverId];
	await writeServersFile(vaultPath, file);
	const enablement = await readEnablementFile(vaultPath);
	delete enablement.enabled[serverId];
	delete enablement.approved[serverId];
	await writeEnablementFile(vaultPath, enablement);
	return true;
}

/** Set a server's per-device enablement. A server that doesn't exist in the
 *  record is a no-op (you can't enable what isn't configured). */
export async function setMcpServerEnabled(
	vaultPath: string,
	serverId: string,
	enabled: boolean,
): Promise<boolean> {
	const servers = await readServersFile(vaultPath);
	if (!(serverId in servers.servers)) return false;
	const enablement = await readEnablementFile(vaultPath);
	enablement.enabled[serverId] = enabled;
	await writeEnablementFile(vaultPath, enablement);
	return true;
}

/** Read the per-device approved-fingerprint baseline for a server (rug-pull
 *  comparison). Empty when nothing approved yet. */
export async function getApprovedFingerprints(
	vaultPath: string,
	serverId: string,
): Promise<McpApprovedFingerprints> {
	const enablement = await readEnablementFile(vaultPath);
	return enablement.approved[serverId] ?? {};
}

/** Store the per-device approved-fingerprint baseline for a server (called when
 *  the user reviews/approves the current tool surface). */
export async function setApprovedFingerprints(
	vaultPath: string,
	serverId: string,
	fingerprints: McpApprovedFingerprints,
): Promise<void> {
	const enablement = await readEnablementFile(vaultPath);
	enablement.approved[serverId] = fingerprints;
	await writeEnablementFile(vaultPath, enablement);
}
