/**
 * MCP HTTP transport over the network egress broker (doc 64 §Transports —
 * MCP-1, HTTP-first v1).
 *
 * A remote MCP server speaks JSON-RPC 2.0. v1 connects the Streamable-HTTP /
 * SSE transport families: the broker POSTs a JSON-RPC request to the server's
 * endpoint and reads back a JSON-RPC response (Streamable-HTTP returns the
 * response in the POST body directly; an SSE server frames it as a `data:`
 * event — this client accepts both by extracting the first JSON object from the
 * response body, which covers both the `application/json` and
 * `text/event-stream` single-response shapes the v1 tools surface needs).
 *
 * EVERY request rides {@link executeNetworkFetch} (the per-origin egress gate,
 * SSRF guard, DNS-pinning, size/time caps, audit) — the broker NEVER touches the
 * network directly, mirroring the AI cloud providers + the 11b.8 HTTP step. The
 * auth secret (a Tier-2 credential read main-only) is framed into the
 * `Authorization: Bearer` header by the caller; `executeNetworkFetch` forwards
 * it and STRIPS it on a cross-origin redirect (it's in `CROSS_ORIGIN_STRIPPED_HEADERS`).
 *
 * Pure-async over an injected `fetchJson` seam so the discovery / call / framing
 * logic is unit-testable without Electron or a live server.
 */

import {
	MCP_TOOLS_PER_SERVER_MAX,
	type McpToolDescriptor,
	sanitizeToolDescriptor,
} from "@brainstorm-os/sdk-types";

/** Per-request budgets. `tools/list` + `tools/call` are interactive — short
 *  enough to keep a down server from blocking the loop (doc 64 §budgets:
 *  discovery < 500ms p95 network-bound, isolated past budget), generous enough
 *  for a real round-trip. */
export const MCP_DISCOVERY_TIMEOUT_MS = 10_000;
export const MCP_CALL_TIMEOUT_MS = 60_000;
export const MCP_RESPONSE_SIZE_CAP_BYTES = 4 * 1024 * 1024;

/** The injected HTTP seam — production binds it to `executeNetworkFetch`; tests
 *  inject a deterministic stub. Returns the decoded body text + status. */
export type McpFetchJson = (input: {
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly bodyJson: unknown;
	readonly timeoutMs: number;
	readonly sizeCapBytes: number;
}) => Promise<{ status: number; text: string }>;

export class McpTransportError extends Error {
	override readonly name = "McpTransportError";
}

let nextRpcId = 1;

function rpcEnvelope(method: string, params: Record<string, unknown>): Record<string, unknown> {
	return { jsonrpc: "2.0", id: nextRpcId++, method, params };
}

/** Pull the first balanced top-level JSON object out of a response body, whether
 *  it's raw `application/json` or wrapped in SSE `data:` framing. Reuses the
 *  same balanced-brace scan the agent loop uses for model replies. Returns the
 *  parsed object or null. */
function parseJsonRpc(text: string): Record<string, unknown> | null {
	const start = text.indexOf("{");
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	let end = -1;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) {
				end = i + 1;
				break;
			}
		}
	}
	if (end < 0) return null;
	try {
		const value = JSON.parse(text.slice(start, end));
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/** Issue one JSON-RPC method over the HTTP transport, returning its `result`.
 *  Throws {@link McpTransportError} on a non-2xx status, an unparseable body, or
 *  a JSON-RPC `error` member (so the broker fails closed). */
async function rpc(
	fetchJson: McpFetchJson,
	url: string,
	authHeader: Readonly<Record<string, string>>,
	method: string,
	params: Record<string, unknown>,
	timeoutMs: number,
): Promise<Record<string, unknown>> {
	const { status, text } = await fetchJson({
		url,
		headers: {
			"Content-Type": "application/json",
			// Streamable-HTTP servers may answer as JSON or SSE; accept both.
			Accept: "application/json, text/event-stream",
			...authHeader,
		},
		bodyJson: rpcEnvelope(method, params),
		timeoutMs,
		sizeCapBytes: MCP_RESPONSE_SIZE_CAP_BYTES,
	});
	if (status < 200 || status >= 300) {
		throw new McpTransportError(`${method}: server returned status ${status}`);
	}
	const parsed = parseJsonRpc(text);
	if (!parsed) throw new McpTransportError(`${method}: response was not a JSON-RPC object`);
	if (parsed.error && typeof parsed.error === "object") {
		const err = parsed.error as { message?: unknown };
		throw new McpTransportError(
			`${method}: ${typeof err.message === "string" ? err.message : "server error"}`,
		);
	}
	const result = parsed.result;
	if (!result || typeof result !== "object") {
		throw new McpTransportError(`${method}: response missing a result object`);
	}
	return result as Record<string, unknown>;
}

/** Sanitise a `tools/list` RPC result into the length-capped,
 *  annotation-defaulted descriptors (a malformed entry is dropped, never
 *  offered; capped at {@link MCP_TOOLS_PER_SERVER_MAX}). Transport-agnostic —
 *  shared by the HTTP + stdio transports so the projection rule lives once. */
export function toolsFromListResult(result: Record<string, unknown>): McpToolDescriptor[] {
	const rawTools = Array.isArray(result.tools) ? result.tools : [];
	const out: McpToolDescriptor[] = [];
	for (const raw of rawTools.slice(0, MCP_TOOLS_PER_SERVER_MAX)) {
		const tool = sanitizeToolDescriptor(raw);
		if (tool) out.push(tool);
	}
	return out;
}

/** Shape a `tools/call` RPC result into the {@link McpCallResult}. The content
 *  is UNTRUSTED external input the caller tags before feeding the model. */
export function callResultFromRpc(result: Record<string, unknown>): McpCallResult {
	return { content: result.content ?? null, isError: result.isError === true };
}

/** Discover a server's tools (`tools/list`). Sanitises every entry to the
 *  length-capped, annotation-defaulted {@link McpToolDescriptor}; a malformed
 *  entry is dropped, never offered. Capped at {@link MCP_TOOLS_PER_SERVER_MAX}. */
export async function discoverTools(
	fetchJson: McpFetchJson,
	url: string,
	authHeader: Readonly<Record<string, string>>,
): Promise<McpToolDescriptor[]> {
	const result = await rpc(fetchJson, url, authHeader, "tools/list", {}, MCP_DISCOVERY_TIMEOUT_MS);
	return toolsFromListResult(result);
}

/** The result of a `tools/call`. `content` is the (UNTRUSTED) tool output that
 *  the loop tags as untrusted before feeding it back to the model; `isError`
 *  flags a tool-reported error (distinct from a transport error). */
export type McpCallResult = {
	readonly content: unknown;
	readonly isError: boolean;
};

/** Invoke a tool (`tools/call`). The `content` it returns is UNTRUSTED external
 *  input (doc 64 §Prompt injection) — the broker tags it accordingly. */
export async function callTool(
	fetchJson: McpFetchJson,
	url: string,
	authHeader: Readonly<Record<string, string>>,
	toolName: string,
	args: Record<string, unknown>,
): Promise<McpCallResult> {
	const result = await rpc(
		fetchJson,
		url,
		authHeader,
		"tools/call",
		{ name: toolName, arguments: args },
		MCP_CALL_TIMEOUT_MS,
	);
	return callResultFromRpc(result);
}
