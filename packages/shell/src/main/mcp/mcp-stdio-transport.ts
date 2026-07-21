/**
 * MCP stdio (local-process) transport (MCP-2, OQ-MCP-2 resolved — plain child +
 * `mcp.spawn-local` consent).
 *
 * A local MCP server is a child process that speaks JSON-RPC 2.0 over
 * newline-delimited JSON on stdin/stdout (the MCP stdio framing: one message
 * per line, UTF-8, no embedded newlines). This transport spawns it with
 * **`shell: false`** (argv passed verbatim — no shell interpolation), runs the
 * required `initialize` handshake, then the one method, and **kills the process
 * when the RPC completes** (spawn-per-RPC). That keeps the model identical to
 * the stateless HTTP transport: no long-lived process lingers, no cross-call
 * state leaks, a hung server is killed at the timeout. The `mcp.spawn-local` +
 * `mcp.server:<id>` capability gates live in the service (re-checked vs the
 * ledger) — this module only spawns + frames once the broker has authorised it.
 *
 * Pure over an injected {@link StdioSpawn} seam so the framing / handshake /
 * lifecycle logic is unit-testable without spawning a real process.
 */

import type { McpToolDescriptor } from "@brainstorm-os/sdk-types";
import {
	MCP_CALL_TIMEOUT_MS,
	MCP_DISCOVERY_TIMEOUT_MS,
	MCP_RESPONSE_SIZE_CAP_BYTES,
	type McpCallResult,
	McpTransportError,
	callResultFromRpc,
	toolsFromListResult,
} from "./mcp-transport";

/** The MCP protocol version this client advertises in `initialize`. A server
 *  negotiates its own; sending a known recent version is the contract. */
const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Grace before escalating a SIGTERM to SIGKILL — a server that ignores
 *  SIGTERM (or is wedged in uninterruptible IO) would otherwise linger. */
const STDIO_KILL_GRACE_MS = 2_000;

/** Ceiling on concurrent local spawns across the whole process (DoS floor — an
 *  agent loop can drive back-to-back `tools/call`s, each spawn-per-RPC; without
 *  a cap a runaway loop becomes a fork bomb). Excess is refused fail-closed, not
 *  queued (queueing would stall the loop behind a wedged server). */
const MAX_CONCURRENT_STDIO_SPAWNS = 8;

/** Live count of spawned-but-not-yet-reaped stdio children (module-global — the
 *  cap is process-wide, not per-server). */
let activeStdioSpawns = 0;

/** The minimal child-process surface this transport drives — Node's
 *  `child_process.spawn` return value satisfies it structurally; tests inject a
 *  fake. Only the pipes + lifecycle events the framing needs are named. */
export type StdioChild = {
	readonly stdin: { write(chunk: string): void; end(): void } | null;
	readonly stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): void } | null;
	on(event: "error", listener: (err: Error) => void): void;
	on(event: "exit", listener: (code: number | null) => void): void;
	kill(signal?: string): void;
};

/** The spawn seam — production binds it to `child_process.spawn` (with
 *  `shell:false`); tests inject a deterministic fake. */
export type StdioSpawn = (command: string, args: readonly string[]) => StdioChild;

type JsonRpcMessage = {
	id?: number;
	result?: unknown;
	error?: { message?: unknown };
};

/**
 * Spawn the server, handshake, run ONE method, and kill it. Resolves with the
 * JSON-RPC `result` object; throws {@link McpTransportError} on spawn failure,
 * a non-zero/early exit, a JSON-RPC error, a timeout, or an over-cap response.
 */
async function runStdioRpc(
	spawn: StdioSpawn,
	command: string,
	args: readonly string[],
	method: string,
	params: Record<string, unknown>,
	timeoutMs: number,
): Promise<Record<string, unknown>> {
	if (activeStdioSpawns >= MAX_CONCURRENT_STDIO_SPAWNS) {
		throw new McpTransportError(
			`refusing to spawn — ${MAX_CONCURRENT_STDIO_SPAWNS} local MCP servers already running`,
		);
	}
	activeStdioSpawns++;
	try {
		return await spawnAndRun(spawn, command, args, method, params, timeoutMs);
	} finally {
		activeStdioSpawns--;
	}
}

/** The spawn + handshake + one-method body, factored so the concurrency
 *  counter's try/finally in {@link runStdioRpc} wraps every exit path. */
async function spawnAndRun(
	spawn: StdioSpawn,
	command: string,
	args: readonly string[],
	method: string,
	params: Record<string, unknown>,
	timeoutMs: number,
): Promise<Record<string, unknown>> {
	let child: StdioChild;
	try {
		child = spawn(command, args);
	} catch (err) {
		throw new McpTransportError(`spawn failed: ${(err as Error).message}`);
	}
	if (!child.stdin || !child.stdout) {
		child.kill();
		throw new McpTransportError("spawn produced no stdio pipes");
	}
	const stdin = child.stdin;
	const stdout = child.stdout;

	return await new Promise<Record<string, unknown>>((resolve, reject) => {
		let settled = false;
		let nextId = 1;
		let buffered = "";
		let bytes = 0;
		const pending = new Map<number, (msg: JsonRpcMessage) => void>();
		// biome-ignore lint/style/useConst: assigned once but `cleanup` closes over it before the setTimeout below
		let timer: ReturnType<typeof setTimeout> | undefined;

		const cleanup = (): void => {
			if (timer) clearTimeout(timer);
			// Unblock any in-flight `request()` awaiter so the handshake IIFE can
			// unwind (it re-checks `settled` after the await and returns) rather
			// than dangling on a promise that never resolves.
			for (const res of pending.values()) res({ error: { message: "aborted" } });
			pending.clear();
			try {
				child.kill();
			} catch {
				// best-effort — the process may already be gone
			}
			// Escalate to SIGKILL if the server ignores SIGTERM. Unref'd so it never
			// holds the event loop; killing an already-dead process is a no-op we
			// swallow. A fast, well-behaved server exits on SIGTERM long before this.
			const killTimer = setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					// already gone
				}
			}, STDIO_KILL_GRACE_MS);
			(killTimer as { unref?: () => void }).unref?.();
		};
		const fail = (message: string): void => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(new McpTransportError(message));
		};
		const succeed = (value: Record<string, unknown>): void => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(value);
		};

		timer = setTimeout(() => fail(`${method}: timed out after ${timeoutMs}ms`), timeoutMs);

		const send = (msg: Record<string, unknown>): void => {
			try {
				stdin.write(`${JSON.stringify(msg)}\n`);
			} catch (err) {
				fail(`write failed: ${(err as Error).message}`);
			}
		};
		const request = (m: string, p: Record<string, unknown>): Promise<JsonRpcMessage> =>
			new Promise<JsonRpcMessage>((res) => {
				const id = nextId++;
				pending.set(id, res);
				send({ jsonrpc: "2.0", id, method: m, params: p });
			});

		child.on("error", (err) => fail(`process error: ${err.message}`));
		child.on("exit", (code) => fail(`process exited (${code ?? "signal"}) before responding`));

		stdout.on("data", (chunk) => {
			if (settled) return; // post-settle bytes (after kill): stop parse churn
			bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
			if (bytes > MCP_RESPONSE_SIZE_CAP_BYTES) {
				fail(`response exceeded ${MCP_RESPONSE_SIZE_CAP_BYTES} bytes`);
				return;
			}
			buffered += chunk.toString();
			let newline = buffered.indexOf("\n");
			while (newline >= 0) {
				const line = buffered.slice(0, newline).trim();
				buffered = buffered.slice(newline + 1);
				newline = buffered.indexOf("\n");
				if (!line) continue;
				let msg: JsonRpcMessage | null = null;
				try {
					const parsed = JSON.parse(line);
					if (parsed && typeof parsed === "object") msg = parsed as JsonRpcMessage;
				} catch {
					// A non-JSON line (a server logging to stdout) is ignored, never fatal.
				}
				if (!msg || typeof msg.id !== "number") continue; // notifications/logs: skip
				const waiter = pending.get(msg.id);
				if (!waiter) continue;
				pending.delete(msg.id);
				waiter(msg);
			}
		});

		// Drive the handshake → method sequence. Any rejection routes to `fail`.
		void (async () => {
			try {
				const init = await request("initialize", {
					protocolVersion: MCP_PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: "brainstorm", version: "1" },
				});
				if (settled) return;
				if (init.error) throw new Error(rpcErrorText(init));
				// Fire-and-forget the required `initialized` notification (no id).
				send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

				const out = await request(method, params);
				if (settled) return;
				if (out.error) throw new Error(rpcErrorText(out));
				if (!out.result || typeof out.result !== "object") {
					throw new Error(`${method}: response missing a result object`);
				}
				succeed(out.result as Record<string, unknown>);
			} catch (err) {
				fail((err as Error).message);
			}
		})();
	});
}

function rpcErrorText(msg: JsonRpcMessage): string {
	const m = msg.error?.message;
	return typeof m === "string" ? m : "server error";
}

/** Discover a local stdio server's tools (`tools/list`). */
export async function discoverToolsStdio(
	spawn: StdioSpawn,
	command: string,
	args: readonly string[],
): Promise<McpToolDescriptor[]> {
	const result = await runStdioRpc(spawn, command, args, "tools/list", {}, MCP_DISCOVERY_TIMEOUT_MS);
	return toolsFromListResult(result);
}

/** Invoke a tool on a local stdio server (`tools/call`). The returned content is
 *  UNTRUSTED — the caller tags it before feeding the model. */
export async function callToolStdio(
	spawn: StdioSpawn,
	command: string,
	args: readonly string[],
	toolName: string,
	toolArgs: Record<string, unknown>,
): Promise<McpCallResult> {
	const result = await runStdioRpc(
		spawn,
		command,
		args,
		"tools/call",
		{ name: toolName, arguments: toolArgs },
		MCP_CALL_TIMEOUT_MS,
	);
	return callResultFromRpc(result);
}
