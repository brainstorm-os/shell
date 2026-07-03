/**
 * Stage 10.4 — `Bun.serve`-backed blind relay server.
 *
 * One process. One port. Pure-WebSocket transport. The wire protocol is
 * the first-byte-tagged channel: `0x00` = JSON control message
 * (subscribe/unsubscribe), `0x01` = opaque `EncryptedFrame` bytes. The
 * relay never parses past the routing header inside the frame.
 *
 * **Relay-blind invariant.** Zero crypto imports anywhere in the server
 * code path. The 12th structural CI fence at
 * `tools/mcp-server/src/tools/relay-noble-import-check.ts` is extended
 * in 10.4 to also match `packages/relay-server/src/**`, so adding a
 * `@noble/*` / envelope-seal import fails the audit.
 *
 * The server itself is a tiny orchestration shim around `FrameRouter` —
 * the actual decision-making is in `router.ts`, so the server is testable
 * by driving the WebSocket handlers directly.
 */

// relay-blind: this file intentionally has zero crypto/credential imports.
// The CI gate covers the relay-server package; the imports below are
// forbidden and any future addition requires a per-line
// `// relay-blind-exempt` review note.

import { AuditLog, type AuditSink } from "./audit-log";
import { FrameRouter } from "./router";

const CONTROL_CHANNEL_BYTE = 0x00;
const FRAME_CHANNEL_BYTE = 0x01;

export type RelayServerOptions = {
	port: number;
	auditSink?: AuditSink;
	/** Override the connection-id generator for deterministic tests. */
	mintConnId?: () => string;
	now?: () => number;
};

export type SubscribeControl = { op: "subscribe"; entityIds: string[] };
export type UnsubscribeControl = { op: "unsubscribe"; entityIds: string[] };
/** Stage 10.11 — routing-token rotation. This forward-only relay has no
 *  durable storage to re-home, so a rotate is pure routing: move the old
 *  token's subscribers onto the new token and alias `from → to` for the
 *  grace window. Mirrors `brainstorm-sync`'s verb (which also migrates
 *  storage + checks catalog ownership on gated nodes). */
export type RotateControl = { op: "rotate"; from: string; to: string; account?: string };
export type RelayControlMessage = SubscribeControl | UnsubscribeControl | RotateControl;

/** Stage 10.11 — rotation ack (server→client). The client flips emission to
 *  the new token ONLY on this ack (fail-closed: no ack ⇒ old token stays). */
export type RotatedMessage = { op: "rotated"; from: string; to: string };

/** Stage 10.11 — dual-token grace window default (matches the sync node). */
export const DEFAULT_ROTATE_GRACE_MS = 10 * 60_000;

/**
 * Minimal Bun-ws-shaped interface so the server module is testable
 * without spinning a real socket. The shape is the intersection of
 * `Bun.ServerWebSocket` and `ws.WebSocket` that we actually use.
 */
export interface ServerWebSocketLike {
	send(data: Uint8Array | string): void;
	close(code?: number, reason?: string): void;
	readonly data?: { connId?: string };
}

export type ConnectionHandlers = {
	onOpen(ws: ServerWebSocketLike): string;
	onMessage(ws: ServerWebSocketLike, raw: Uint8Array | string): void;
	onClose(ws: ServerWebSocketLike): void;
};

export type RelayCore = {
	router: FrameRouter;
	audit: AuditLog;
	handlers: ConnectionHandlers;
	/** Set of active connections keyed by connId. Test-visible. */
	connections: Map<string, ServerWebSocketLike>;
};

/**
 * Build the routing + audit + handler core. The HTTP/WS server itself
 * (`Bun.serve(...)`) is built in `bin/relay.ts`; everything testable
 * lives here.
 */
export function createRelayCore(
	opts: {
		auditSink?: AuditSink;
		mintConnId?: () => string;
		now?: () => number;
		/** Stage 10.11 — dual-token grace window for routing rotation (ms). */
		rotateGraceMs?: number;
	} = {},
): RelayCore {
	const audit = new AuditLog({
		...(opts.auditSink ? { sink: opts.auditSink } : {}),
		...(opts.now ? { now: opts.now } : {}),
	});
	const now = opts.now ?? Date.now;
	const rotateGraceMs = opts.rotateGraceMs ?? DEFAULT_ROTATE_GRACE_MS;
	const router = new FrameRouter(audit, { now });
	const connections = new Map<string, ServerWebSocketLike>();
	const mintConnId = opts.mintConnId ?? defaultMintConnId();

	function send(toConnId: string, frame: Uint8Array): void {
		const ws = connections.get(toConnId);
		if (!ws) return;
		// Re-wrap with the frame channel byte. The relay's outbound wire
		// always carries the `0x01` discriminator so the recipient client
		// can route the same way it routes any other inbound frame.
		const wire = new Uint8Array(1 + frame.length);
		wire[0] = FRAME_CHANNEL_BYTE;
		wire.set(frame, 1);
		try {
			ws.send(wire);
		} catch {
			// Already-closed sockets can throw on Bun; the router calls
			// us through a try/catch so an individual failure doesn't
			// block fan-out.
		}
	}

	function sendControlReply(toConnId: string, message: RotatedMessage): void {
		const ws = connections.get(toConnId);
		if (!ws) return;
		const body = new TextEncoder().encode(JSON.stringify(message));
		const wire = new Uint8Array(1 + body.length);
		wire[0] = CONTROL_CHANNEL_BYTE;
		wire.set(body, 1);
		try {
			ws.send(wire);
		} catch {
			// closed socket — drop quietly.
		}
	}

	const handlers: ConnectionHandlers = {
		onOpen(ws) {
			const connId = mintConnId();
			(ws as { data?: { connId?: string } }).data = { connId };
			connections.set(connId, ws);
			return connId;
		},
		onMessage(ws, raw) {
			const connId = (ws as { data?: { connId?: string } }).data?.connId;
			if (!connId) return;
			const bytes = normalizeIncoming(raw);
			if (!bytes || bytes.length < 1) return;
			const channel = bytes[0];
			if (channel === FRAME_CHANNEL_BYTE) {
				const frame = bytes.subarray(1);
				router.route(connId, frame, send);
				return;
			}
			if (channel === CONTROL_CHANNEL_BYTE) {
				const message = parseControl(bytes.subarray(1));
				if (!message) return;
				if (message.op === "rotate") {
					// 10.11 — alias-only on this storeless relay: move subscribers,
					// install the grace alias, ack. Ack LAST so the client's flip is
					// ordered after the routing change (fail-closed on its side).
					router.applyRotation(message.from, message.to, now() + rotateGraceMs);
					sendControlReply(connId, { op: "rotated", from: message.from, to: message.to });
					return;
				}
				if (message.op === "subscribe") {
					for (const entityId of message.entityIds) router.subscribe(connId, entityId);
				} else {
					for (const entityId of message.entityIds) router.unsubscribe(connId, entityId);
				}
				return;
			}
			// Unknown channel byte — drop silently. Stays available for
			// forward-compat (a future control sub-channel).
		},
		onClose(ws) {
			const connId = (ws as { data?: { connId?: string } }).data?.connId;
			if (!connId) return;
			router.dropConnection(connId);
			connections.delete(connId);
		},
	};

	return { router, audit, handlers, connections };
}

function parseControl(body: Uint8Array): RelayControlMessage | null {
	try {
		const json = new TextDecoder().decode(body);
		const parsed = JSON.parse(json) as unknown;
		if (!parsed || typeof parsed !== "object") return null;
		const v = parsed as { op?: unknown; entityIds?: unknown; from?: unknown; to?: unknown };
		if (v.op === "rotate") {
			if (typeof v.from !== "string" || v.from.length === 0) return null;
			if (typeof v.to !== "string" || v.to.length === 0) return null;
			if (v.from === v.to) return null;
			return { op: "rotate", from: v.from, to: v.to };
		}
		if (v.op !== "subscribe" && v.op !== "unsubscribe") return null;
		if (!Array.isArray(v.entityIds)) return null;
		const entityIds = v.entityIds.filter((e): e is string => typeof e === "string" && e.length > 0);
		return { op: v.op, entityIds };
	} catch {
		return null;
	}
}

function normalizeIncoming(raw: Uint8Array | string): Uint8Array | null {
	if (raw instanceof Uint8Array) return raw;
	if (typeof raw === "string") {
		// A plain string body has no channel prefix; we cannot route it.
		// Drop — the wire protocol is binary-only.
		return null;
	}
	return null;
}

function defaultMintConnId(): () => string {
	let counter = 0;
	return () => {
		counter += 1;
		const random = Math.random().toString(36).slice(2, 8);
		return `c${counter}_${random}`;
	};
}
