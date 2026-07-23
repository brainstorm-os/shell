/**
 * @brainstorm-os/relay-server — a blind WebSocket relay.
 *
 * A tiny forward-only fan-out server: clients subscribe to opaque routing
 * keys and the relay forwards end-to-end-encrypted frames between them
 * without ever decoding the payload. Zero crypto, zero storage, zero trust.
 *
 * The programmatic surface is `createRelayCore` — the routing + audit + WS
 * handler core, testable without a live socket. `bin/relay.ts` wraps it in a
 * `Bun.serve` listener for a runnable process.
 */

export {
	type ConnectionHandlers,
	type RelayControlMessage,
	type RelayCore,
	type RelayServerOptions,
	type RotateControl,
	type RotatedMessage,
	type ServerWebSocketLike,
	type SubscribeControl,
	type UnsubscribeControl,
	createRelayCore,
	DEFAULT_ROTATE_GRACE_MS,
} from "./server";
export { type RouteResult, FrameRouter } from "./router";
export {
	type AuditEntry,
	type AuditEntryInput,
	type AuditSink,
	AuditLog,
} from "./audit-log";
export {
	type RoutingHeader,
	ED25519_SIG_BYTES,
	PROTOCOL_VERSION,
	WireKind,
	parseRoutingHeaderJson,
	peekRoutingHeader,
} from "./wire";
