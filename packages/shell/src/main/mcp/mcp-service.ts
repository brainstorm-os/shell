/**
 * The `mcp` broker service — the app-facing surface of the MCP broker (doc 64,
 * MCP-1/-4). Apps (the Agent app, an Automations AIAgent step) reach it through
 * the IPC broker; the SDK proxy declares the per-server `mcp.server:<id>`
 * capability, and the broker checks it against the ledger before forwarding.
 *
 * Methods:
 *   - `listTools({ serverIds? })` → the fail-closed set of {@link McpAgentTool}s
 *     the caller may use: only ENABLED + reachable servers, only those the
 *     caller's frozen caps grant `mcp.server:<id>` (re-checked vs the ledger),
 *     projected + intersected. A conversation only ever SEES tools of servers it
 *     was granted.
 *   - `callTool({ serverId, toolName, args, confirmed? })` → the (UNTRUSTED)
 *     tool result. Fail-closed at every gate: server must exist + be enabled +
 *     be granted; the friction model decides whether a confirm was required (and
 *     refuses if the caller didn't confirm a write / a rug-pulled tool); every
 *     call audits (arg-SHAPE only).
 *
 * **Fail-closed throughout** (the IPC-broker invariant): no server / no grant /
 * no key / down / unconfirmed-write / rug-pull → a typed `Unavailable` /
 * `Denied` / `NeedsConfirm` error, NEVER a silent call.
 *
 * SECURITY: like the network handler, the broker's generic declared-caps check
 * is necessary-but-not-sufficient (the app controls `envelope.caps`). The
 * `mcp.server:<id>` cap is scarce (not a default grant), so we RE-CHECK it
 * against the active vault's ledger here — the authoritative gate.
 */

import { type CapabilityLedger, LedgerUnavailableError } from "@brainstorm-os/capabilities/ledger";
import {
	MCP_SPAWN_LOCAL_CAP,
	type McpAgentTool,
	McpFrictionDecision,
	type McpToolDescriptor,
	decideToolFriction,
	detectRugPull,
	intersectMcpTools,
	isHttpMcpTransport,
	isServerGranted,
	isStdioMcpTransport,
	mcpServerCapability,
	projectMcpTools,
	toolDescriptorFingerprint,
} from "@brainstorm-os/sdk-types";
import type { ServiceHandler } from "../../ipc/broker";
import type { Envelope } from "../../ipc/envelope";
import { McpCallOutcome, type McpCallRecord, argKeysOf } from "./mcp-audit-log";
import {
	type McpServerView,
	getApprovedFingerprints,
	listMcpServers,
	setApprovedFingerprints,
} from "./mcp-config-store";

/** A connected-server handle the service uses to discover + call. Production
 *  binds it to the HTTP transport (over `executeNetworkFetch`) with the auth
 *  secret resolved main-only; tests inject a deterministic stub. The secret is
 *  NEVER part of this contract — the binding closes over it. */
export type McpConnection = {
	listTools: () => Promise<McpToolDescriptor[]>;
	callTool: (
		toolName: string,
		args: Record<string, unknown>,
	) => Promise<{ content: unknown; isError: boolean }>;
};

export type McpServiceOptions = {
	/** The active vault path (per-vault config record + per-device enablement).
	 *  `null` → no open vault: the service fails closed (`Unavailable`). */
	readonly getVaultPath: () => string | null;
	/** SECURITY — the active vault's capability ledger, used to re-check the
	 *  `mcp.server:<id>` grant server-side (never trusting `envelope.caps`).
	 *  Absent → the cap gate is skipped (unit tests that presume authorization). */
	readonly getLedger?: () => Promise<CapabilityLedger | null>;
	/** Open a connection to a configured + enabled server. Returns null when the
	 *  server is unreachable (treated as `down` — its tools drop out). The binding
	 *  resolves the Tier-2 auth secret main-only. */
	readonly connect: (server: McpServerView) => Promise<McpConnection | null>;
	/** Per-call audit sink (arg-shape only). Omitted in tests that don't assert. */
	readonly onCall?: (record: McpCallRecord) => void;
	readonly now?: () => number;
};

function makeError(name: string, message: string): Error {
	const err = new Error(message);
	err.name = name;
	return err;
}

/** Re-check the `mcp.server:<id>` grant against the ledger (the authoritative
 *  gate). Fails closed: ledger error / no vault → `Unavailable`; not held →
 *  `Denied`. No-op when `getLedger` is unwired. */
async function requireServerGrant(
	envelope: Envelope,
	options: McpServiceOptions,
	serverId: string,
): Promise<void> {
	if (!options.getLedger) return;
	let ledger: CapabilityLedger | null;
	try {
		ledger = await options.getLedger();
	} catch (error) {
		if (error instanceof LedgerUnavailableError) {
			throw makeError("Unavailable", "mcp: capability ledger unavailable");
		}
		throw error;
	}
	if (!ledger) throw makeError("Unavailable", "mcp: no active vault session");
	let held: boolean;
	try {
		held = ledger.has(envelope.app, mcpServerCapability(serverId));
	} catch (error) {
		if (error instanceof LedgerUnavailableError) {
			throw makeError("Unavailable", "mcp: capability ledger unavailable");
		}
		throw error;
	}
	if (!held) {
		throw makeError("Denied", `mcp.callTool: ${envelope.app} lacks ${mcpServerCapability(serverId)}`);
	}
}

/** The frozen capability set the caller may use — the `mcp.server:*` grants the
 *  envelope declares AND the ledger confirms. We start from the declared caps
 *  (the app's chosen subset) and, when a ledger is wired, keep only those it
 *  actually holds (a conversation can NARROW; it can never broaden past the
 *  ledger). Fail-closed. */
async function frozenServerGrants(
	envelope: Envelope,
	options: McpServiceOptions,
): Promise<string[]> {
	const declared = envelope.caps.filter((cap) => cap.startsWith("mcp.server:"));
	if (!options.getLedger) return declared;
	let ledger: CapabilityLedger | null;
	try {
		ledger = await options.getLedger();
	} catch {
		return [];
	}
	if (!ledger) return [];
	return declared.filter((cap) => {
		try {
			return ledger.has(envelope.app, cap);
		} catch {
			return false;
		}
	});
}

function validateListArgs(args: readonly unknown[]): { serverIds?: string[] } {
	const [arg] = args as [unknown];
	if (arg === undefined || arg === null) return {};
	if (typeof arg !== "object" || Array.isArray(arg)) {
		throw makeError("Invalid", "mcp.listTools: argument must be an object");
	}
	const a = arg as Record<string, unknown>;
	if (a.serverIds === undefined) return {};
	if (!Array.isArray(a.serverIds) || a.serverIds.some((s) => typeof s !== "string")) {
		throw makeError("Invalid", "mcp.listTools: { serverIds } must be a string array");
	}
	return { serverIds: a.serverIds as string[] };
}

type ValidatedCallArgs = {
	serverId: string;
	toolName: string;
	args: Record<string, unknown>;
	confirmed: boolean;
};

function validateCallArgs(args: readonly unknown[]): ValidatedCallArgs {
	const [arg] = args as [unknown];
	if (!arg || typeof arg !== "object" || Array.isArray(arg)) {
		throw makeError("Invalid", "mcp.callTool: argument must be an object");
	}
	const a = arg as Record<string, unknown>;
	if (typeof a.serverId !== "string" || a.serverId.length === 0) {
		throw makeError("Invalid", "mcp.callTool: { serverId } must be a non-empty string");
	}
	if (typeof a.toolName !== "string" || a.toolName.length === 0) {
		throw makeError("Invalid", "mcp.callTool: { toolName } must be a non-empty string");
	}
	const callArgs =
		a.args && typeof a.args === "object" && !Array.isArray(a.args)
			? (a.args as Record<string, unknown>)
			: {};
	return {
		serverId: a.serverId,
		toolName: a.toolName,
		args: callArgs,
		confirmed: a.confirmed === true,
	};
}

/** A server is OFFERABLE (by transport + enablement) when it is enabled here and
 *  speaks a transport the broker connects — HTTP, or stdio (MCP-2). stdio
 *  additionally requires the caller to hold `mcp.spawn-local` (checked
 *  separately, per-call, against the ledger); this is the server-state gate. */
function isOfferable(server: McpServerView): boolean {
	return (
		server.enabledHere &&
		(isHttpMcpTransport(server.transport) || isStdioMcpTransport(server.transport))
	);
}

/** Whether the caller's frozen caps grant `mcp.spawn-local` — the scarce,
 *  default-off gate on spawning ANY local stdio server (re-checked vs the ledger
 *  when wired; declared-caps only in test mode). Stdio servers/tools are hidden
 *  from a caller without it. */
async function frozenHasSpawnLocal(
	envelope: Envelope,
	options: McpServiceOptions,
): Promise<boolean> {
	if (!envelope.caps.includes(MCP_SPAWN_LOCAL_CAP)) return false;
	if (!options.getLedger) return true;
	let ledger: CapabilityLedger | null;
	try {
		ledger = await options.getLedger();
	} catch {
		return false;
	}
	if (!ledger) return false;
	try {
		return ledger.has(envelope.app, MCP_SPAWN_LOCAL_CAP);
	} catch {
		return false;
	}
}

export function makeMcpServiceHandler(options: McpServiceOptions): ServiceHandler {
	const clock = options.now ?? Date.now;
	return async (envelope: Envelope): Promise<unknown> => {
		const vaultPath = options.getVaultPath();
		if (!vaultPath) throw makeError("Unavailable", "mcp: no active vault session");

		switch (envelope.method) {
			case "listTools":
				return await handleListTools(envelope, options, vaultPath);
			case "callTool":
				return await handleCallTool(envelope, options, vaultPath, clock);
			default:
				throw makeError("Invalid", `unknown mcp method: ${envelope.method}`);
		}
	};
}

async function handleListTools(
	envelope: Envelope,
	options: McpServiceOptions,
	vaultPath: string,
): Promise<McpAgentTool[]> {
	const { serverIds } = validateListArgs(envelope.args);
	const frozen = await frozenServerGrants(envelope, options);
	const spawnLocal = await frozenHasSpawnLocal(envelope, options);
	const servers = (await listMcpServers(vaultPath)).filter(
		(s) =>
			isOfferable(s) &&
			isServerGranted(s.id, frozen) &&
			// stdio tools are hidden unless the caller also holds `mcp.spawn-local`.
			(!isStdioMcpTransport(s.transport) || spawnLocal) &&
			(!serverIds || serverIds.includes(s.id)),
	);
	const offered: McpAgentTool[] = [];
	for (const server of servers) {
		const connection = await options.connect(server).catch(() => null);
		if (!connection) continue; // down → tools drop out, never blocks
		const tools = await connection.listTools().catch(() => null);
		if (!tools) continue;
		// Project + intersect (fail-closed) — the intersection is redundant given
		// the per-server filter above, but it is the documented keystone and
		// re-asserts the invariant if the filter ever drifts.
		offered.push(...intersectMcpTools(projectMcpTools(server.id, tools), frozen));
	}
	return offered;
}

/** Why a write needs a confirm the caller didn't supply. Carried on a typed
 *  error so the Agent UI surfaces the right confirmable step. */
export class McpNeedsConfirmError extends Error {
	override readonly name = "NeedsConfirm";
	readonly serverId: string;
	readonly toolName: string;
	readonly rugPull: boolean;
	constructor(serverId: string, toolName: string, rugPull: boolean) {
		super(
			rugPull
				? `mcp.callTool: ${serverId}/${toolName} changed since you approved it — re-confirm`
				: `mcp.callTool: ${serverId}/${toolName} is a write — confirm`,
		);
		this.serverId = serverId;
		this.toolName = toolName;
		this.rugPull = rugPull;
	}
}

async function handleCallTool(
	envelope: Envelope,
	options: McpServiceOptions,
	vaultPath: string,
	clock: () => number,
): Promise<{ content: unknown; isError: boolean }> {
	const startedMs = clock();
	const { serverId, toolName, args, confirmed } = validateCallArgs(envelope.args);

	const audit = (outcome: McpCallOutcome, reason?: string): void => {
		if (!options.onCall) return;
		options.onCall({
			ts: clock(),
			appId: envelope.app,
			serverId,
			toolName,
			argKeys: argKeysOf(args),
			outcome,
			durationMs: clock() - startedMs,
			...(reason ? { reason } : {}),
		});
	};

	// 1. Authoritative grant re-check (ledger, fail-closed).
	try {
		await requireServerGrant(envelope, options, serverId);
	} catch (error) {
		audit(McpCallOutcome.Refused, "denied");
		throw error;
	}

	// 2. Server must exist + be enabled here + speak a connectable transport.
	const server = (await listMcpServers(vaultPath)).find((s) => s.id === serverId) ?? null;
	if (!server || !isOfferable(server)) {
		audit(McpCallOutcome.Refused, server ? "disabled" : "no-server");
		throw makeError("Unavailable", `mcp.callTool: server "${serverId}" is unavailable`);
	}

	// 2b. A stdio server spawns a local process — require the scarce, default-off
	//     `mcp.spawn-local` grant on top of the per-server grant (fail-closed).
	if (isStdioMcpTransport(server.transport) && !(await frozenHasSpawnLocal(envelope, options))) {
		audit(McpCallOutcome.Refused, "no-spawn-local");
		throw makeError("Denied", `mcp.callTool: ${envelope.app} lacks ${MCP_SPAWN_LOCAL_CAP}`);
	}

	// 3. Connect (down → unavailable, never a silent no-op).
	const connection = await options.connect(server).catch(() => null);
	if (!connection) {
		audit(McpCallOutcome.Refused, "down");
		throw makeError("Unavailable", `mcp.callTool: server "${serverId}" is down`);
	}

	// 4. Discover the CURRENT tool surface — to (a) find the requested tool's
	//    annotations for the friction decision, and (b) run the rug-pull check.
	const tools = await connection.listTools().catch(() => null);
	if (!tools) {
		audit(McpCallOutcome.Refused, "discovery-failed");
		throw makeError("Unavailable", `mcp.callTool: could not list tools for "${serverId}"`);
	}
	const descriptor = tools.find((t) => t.name === toolName);
	if (!descriptor) {
		audit(McpCallOutcome.Refused, "no-tool");
		throw makeError("Unavailable", `mcp.callTool: server "${serverId}" has no tool "${toolName}"`);
	}

	// 5. Rug-pull defence — a tool whose description/annotations changed since
	//    the user approved it (or that was never approved) must be re-confirmed,
	//    regardless of the read-only hint (a benign→malicious swap is the attack).
	const approved = await getApprovedFingerprints(vaultPath, serverId);
	const rugPulls = detectRugPull([descriptor], approved);
	const rugPulled = rugPulls.length > 0;

	// 6. Friction decision (OQ-MCP-4). A hinted-safe read with NO rug-pull may
	//    auto-run; everything else (write / destructive / unknown-hint /
	//    rug-pulled) requires an explicit confirm.
	const friction = decideToolFriction(descriptor);
	const mayAutoRun = friction === McpFrictionDecision.AutoRun && !rugPulled;
	if (!mayAutoRun && !confirmed) {
		audit(McpCallOutcome.Refused, rugPulled ? "rug-pull" : "needs-confirm");
		throw new McpNeedsConfirmError(serverId, toolName, rugPulled);
	}

	// 7. A confirmed call re-baselines ONLY the confirmed tool's fingerprint —
	//    the user approved THIS tool, not the whole server. Re-baselining the
	//    entire surface here would silently clear the rug-pull flag on every
	//    OTHER changed/new tool, so the next auto-run-eligible one would run
	//    without a prompt (the rug-pull defense must stay per-tool).
	if (confirmed && rugPulled) {
		await setApprovedFingerprints(vaultPath, serverId, {
			...approved,
			[descriptor.name]: toolDescriptorFingerprint(descriptor),
		});
	}

	// 8. Dispatch. The result content is UNTRUSTED — the caller tags it as such
	//    before feeding it to the model (doc 64 §Prompt injection).
	try {
		const result = await connection.callTool(toolName, args);
		audit(result.isError ? McpCallOutcome.Error : McpCallOutcome.Ok);
		return result;
	} catch (error) {
		audit(McpCallOutcome.Error, "dispatch-failed");
		throw makeError("Unavailable", `mcp.callTool: ${(error as Error).message}`);
	}
}
