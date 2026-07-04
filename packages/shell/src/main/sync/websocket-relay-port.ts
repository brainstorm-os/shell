/**
 * Stage 10.4 — WebSocket-backed `RelayPort` adapter.
 *
 * The blind-relay invariant carries forward intact from 10.3a/b: this file
 * **must not** import any crypto library, `../credentials/*`, `./envelope-seal`,
 * or any crypto. The 12th structural CI fence in
 * `tools/mcp-server/src/tools/relay-noble-import-check.ts` is extended to
 * the relay-server package in this iteration AND continues to match the
 * `sync/*relay*.ts` pattern here — adding a forbidden import in either
 * place fails the audit.
 *
 * **Wire protocol** (locked in iteration plan):
 *   - Plain WebSocket. One binary frame per `EncryptedFrame`. The first
 *     byte of every WebSocket message is the channel discriminator:
 *       `0x00` ⇒ JSON control message (`subscribe` / `unsubscribe`).
 *       `0x01` ⇒ opaque `EncryptedFrame` bytes (the rest of the message).
 *   - The relay never parses past the routing header inside the frame;
 *     control messages are subscribe/unsubscribe only.
 *   - The port itself does not subscribe — the wire-path orchestrator
 *     (10.5+) calls `subscribe(entityId)` / `unsubscribe(entityId)` so the
 *     port can re-send subscriptions on every reconnect.
 *
 * **Reconnect schedule.** 500ms → 1s → 2s → 5s → 10s → 30s cap, ±20%
 * jitter applied to each attempt. The schedule resets to 500ms only after
 * a connection holds `Open` for ≥ 30s — this prevents a half-broken
 * server (accepts + immediately drops) from collapsing to a tight loop.
 *
 * **Send queue.** Ring buffer, capacity 256. While connecting or in a
 * reconnect window the producer keeps sending; on overflow the OLDEST
 * non-streaming frame is dropped (drop-oldest) and a counter is bumped.
 * `droppedSends()` exposes the counter so 10.7's sync-status panel can
 * surface "you lost N frames during a long offline window".
 *
 * **State machine.** Exposed via `port.state` (synchronous read) + an
 * `EventEmitter` `state` event so 10.7 can paint live transitions.
 */

// relay-blind: this file intentionally has zero crypto/credential imports.
// The CI gate at tools/mcp-server/src/tools/relay-noble-import-check.ts
// asserts this; the imports below are forbidden and any future addition
// requires a per-line `// relay-blind-exempt` review note.

import { EventEmitter } from "node:events";
import type { CatalogEntry, RelayPort } from "./relay-port";

export enum WebSocketRelayState {
	Idle = "idle",
	Connecting = "connecting",
	Open = "open",
	Reconnecting = "reconnecting",
	Closed = "closed",
	Error = "error",
}

/** First-byte channel discriminator (see file header). */
export const CONTROL_CHANNEL_BYTE = 0x00;
export const FRAME_CHANNEL_BYTE = 0x01;
/** Asset-B4 — the blob plane (Asset-B3 node channel `0x02`): content-addressed
 *  chunk HAS/PUT/GET, a request/response channel distinct from the entity-routed
 *  frame fan-out. Requests are SERIALIZED on this client (one in-flight at a
 *  time) so a response correlates to the head of the queue without a per-request
 *  id — the node answers async + out-of-order under pipelining, so we don't. */
export const ASSET_CHANNEL_BYTE = 0x02;
/** 10.10 — bundled backfill (server→client only): many opaque wire frames
 *  length-prefixed into one WebSocket message. The durable node sends these
 *  only to a client that advertised `bundle:true` on its subscribe, so an old
 *  client never sees the channel; an old NODE ignores the flag and keeps the
 *  per-frame `0x01` stream (the fallback path, no negotiation round-trip). */
export const BUNDLE_CHANNEL_BYTE = 0x03;

/** JSON-tagged control message shape. `bundle` (10.10) advertises that this
 *  client can decode `0x03` bundle messages — the durable node then serves
 *  backfill bundled instead of one message per frame. Additive: an old node's
 *  control parser drops unknown fields. */
export type SubscribeControl = { op: "subscribe"; entityIds: string[]; bundle?: true };
export type UnsubscribeControl = { op: "unsubscribe"; entityIds: string[] };
/** Stage 10.14 — request the account's catalog (client→server). `account` is
 *  the device's wire `sender` (base64url). */
export type CatalogControl = { op: "catalog"; account: string };
/** SYNC-4b — gated-admission handshake reply (client→server). Carries the
 *  `brainstorm-cloud` entitlement token + the device's wire `account` + an
 *  Ed25519 signature over the server's challenge nonce. The payload is opaque
 *  to this port — it's computed by an injected `onChallenge` callback so the
 *  port stays crypto-free (relay-blind). */
export type AuthControl = { op: "auth"; token: string; account: string; sig: string };
/** Stage 10.11 — routing-token rotation (client→server): re-home the durable
 *  node's storage `from → to` and alias the old token for the node's grace
 *  window. Mirrors `brainstorm-sync`'s `RotateControl`. `account` feeds the
 *  node's catalog on an open node; a gated node uses the proven account. */
export type RotateControl = { op: "rotate"; from: string; to: string; account?: string };
export type RelayControlMessage =
	| SubscribeControl
	| UnsubscribeControl
	| CatalogControl
	| RotateControl
	| AuthControl;

/** SYNC-4b — the credential payload an `onChallenge` callback returns. */
export type AuthResponse = { token: string; account: string; sig: string };

/** Stage 10.14 — the node's reply to a `catalog` query (server→client).
 *  Mirrors `brainstorm-sync`'s `CatalogResultMessage`. */
export type CatalogResultMessage = {
	op: "catalog-result";
	account: string;
	entities: CatalogEntry[];
};

/** Stage 10.11 — the node's rotation replies (server→client). Mirrors
 *  `brainstorm-sync`'s `RotatedMessage` / `RotateDeniedMessage`. */
export type RotatedMessage = { op: "rotated"; from: string; to: string };
export type RotateDeniedMessage = { op: "rotate-denied"; from: string; to: string; reason: string };

/** WebSocket-like surface — both the browser `WebSocket` and `ws` libs match. */
export interface WebSocketLike {
	readonly readyState: number;
	send(data: Uint8Array): void;
	close(code?: number, reason?: string): void;
	onopen: ((ev?: unknown) => void) | null;
	onclose: ((ev?: unknown) => void) | null;
	onerror: ((ev?: unknown) => void) | null;
	onmessage: ((ev: { data: unknown }) => void) | null;
}

/**
 * Constructor for a WebSocket implementation. `globalThis.WebSocket`
 * matches under Bun and modern Electron renderer; tests inject a fake.
 */
export type WebSocketCtor = new (url: string) => WebSocketLike;

const OPEN_READY_STATE = 1;
const SEND_QUEUE_CAP = 256;
/** 10.10 — max entity ids per batched subscribe control. Keeps each control
 *  message comfortably under the node's 64 KiB control-size cap. */
const SUBSCRIBE_BATCH_MAX = 256;
const STABLE_OPEN_RESET_MS = 30_000;
const BACKOFF_SCHEDULE_MS = [500, 1_000, 2_000, 5_000, 10_000, 30_000] as const;
const JITTER_FRACTION = 0.2;

export type WebSocketRelayPortOptions = {
	url: string;
	/** Inject a WebSocket constructor for tests (default `globalThis.WebSocket`). */
	wsImpl?: WebSocketCtor;
	/** Inject a random source for jitter tests (default `Math.random`). */
	random?: () => number;
	/** Inject a timer factory for tests (default native `setTimeout`/`clearTimeout`). */
	setTimer?: (cb: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
	/** Inject a clock for tests (default `Date.now`). */
	now?: () => number;
	/** Stage 10.14 — `requestCatalog` reply timeout (default 15 s). */
	catalogTimeoutMs?: number;
	/** Stage 10.11 — `requestRotate` reply timeout (default 15 s). A timeout is
	 *  how a pre-10.11 node (which silently ignores the verb) surfaces: the
	 *  caller keeps the old token — fail-closed. */
	rotateTimeoutMs?: number;
	/** Asset-B4 — `requestAsset` (blob chunk) reply timeout (default 30 s). */
	assetTimeoutMs?: number;
	/** SYNC-4b — respond to a gated node's `challenge`. Given the server nonce,
	 *  return the `{token, account, sig}` to send back, or null to stay
	 *  unauthenticated (an open node never challenges). This is the ONLY place
	 *  credentials/crypto enter the relay path — the callback is injected from a
	 *  non-relay-blind module (`challenge-responder.ts`), keeping this port
	 *  crypto-free. */
	onChallenge?: (nonce: string) => Promise<AuthResponse | null>;
};

export class WebSocketRelayPort implements RelayPort {
	readonly #url: string;
	readonly #wsImpl: WebSocketCtor;
	readonly #random: () => number;
	readonly #setTimer: (cb: () => void, ms: number) => unknown;
	readonly #clearTimer: (handle: unknown) => void;
	readonly #now: () => number;
	readonly #catalogTimeoutMs: number;
	readonly #rotateTimeoutMs: number;
	readonly #assetTimeoutMs: number;
	readonly #onChallenge: ((nonce: string) => Promise<AuthResponse | null>) | null;
	readonly #emitter = new EventEmitter();
	readonly #subscriptions = new Set<string>();
	readonly #listeners = new Set<(frame: Uint8Array) => void>();
	/** Stage 10.14 — in-flight catalog requests keyed by account. */
	readonly #pendingCatalog = new Map<
		string,
		{
			resolve: (entries: CatalogEntry[]) => void;
			reject: (error: Error) => void;
			timer: unknown;
			promise: Promise<CatalogEntry[]>;
		}
	>();
	/** Stage 10.11 — in-flight rotate requests keyed by the OLD token. */
	readonly #pendingRotate = new Map<
		string,
		{
			to: string;
			resolve: () => void;
			reject: (error: Error) => void;
			timer: unknown;
			promise: Promise<void>;
		}
	>();
	/** Asset-B4 — queued asset requests awaiting their turn (only one is in
	 *  flight at a time so the single inbound response correlates by FIFO). */
	readonly #assetQueue: Array<{
		frame: Uint8Array;
		resolve: (frame: Uint8Array) => void;
		reject: (error: Error) => void;
	}> = [];
	/** The single in-flight asset request's resolver (null when idle). */
	#pendingAsset: {
		resolve: (frame: Uint8Array) => void;
		reject: (error: Error) => void;
		timer: unknown;
	} | null = null;
	#state: WebSocketRelayState = WebSocketRelayState.Idle;
	#ws: WebSocketLike | null = null;
	#sendQueue: Uint8Array[] = [];
	#droppedSends = 0;
	#droppedInbound = 0;
	#gatedAdmission = false;
	#attempt = 0;
	#reconnectHandle: unknown = null;
	#openedAtMs: number | null = null;
	#disposed = false;

	constructor(opts: WebSocketRelayPortOptions) {
		this.#url = opts.url;
		const ctor = opts.wsImpl ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
		if (!ctor) {
			throw new Error("WebSocketRelayPort: no WebSocket implementation available");
		}
		this.#wsImpl = ctor;
		this.#random = opts.random ?? Math.random;
		this.#setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
		this.#clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
		this.#now = opts.now ?? Date.now;
		this.#catalogTimeoutMs = opts.catalogTimeoutMs ?? 15_000;
		this.#rotateTimeoutMs = opts.rotateTimeoutMs ?? 15_000;
		this.#assetTimeoutMs = opts.assetTimeoutMs ?? 30_000;
		this.#onChallenge = opts.onChallenge ?? null;
	}

	get state(): WebSocketRelayState {
		return this.#state;
	}

	get url(): string {
		return this.#url;
	}

	droppedSends(): number {
		return this.#droppedSends;
	}

	droppedInbound(): number {
		return this.#droppedInbound;
	}

	/** 14.7 — whether the LIVE connection completed the SYNC-4b gated-admission
	 *  handshake (`auth-ok` received), i.e. this is a hosted/metered node. False
	 *  on an open node (never challenges), while connecting, and after a drop —
	 *  each fresh socket re-authenticates. */
	gatedAdmission(): boolean {
		return this.#state === WebSocketRelayState.Open && this.#gatedAdmission;
	}

	on(event: "state", listener: (state: WebSocketRelayState) => void): this {
		this.#emitter.on(event, listener);
		return this;
	}

	off(event: "state", listener: (state: WebSocketRelayState) => void): this {
		this.#emitter.off(event, listener);
		return this;
	}

	/**
	 * Resolve once the WS has reached `Open`. Reject if `Closed` is reached
	 * first, or if the timeout (default 5 s) elapses without a transition.
	 * Resolves immediately when already Open. The soak harness uses this via
	 * `dev:soak:wait-relay-open` to close the connect-race between
	 * `dev.setSyncRelay` returning and pairing subscribing / sending.
	 */
	awaitOpen(timeoutMs = 5_000): Promise<void> {
		if (this.#state === WebSocketRelayState.Open) return Promise.resolve();
		if (this.#state === WebSocketRelayState.Closed) {
			return Promise.reject(new Error("WebSocketRelayPort.awaitOpen: port already closed"));
		}
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const onStateChange = (state: WebSocketRelayState): void => {
				if (settled) return;
				if (state === WebSocketRelayState.Open) {
					settled = true;
					this.#emitter.off("state", onStateChange);
					this.#clearTimer(timer);
					resolve();
				} else if (state === WebSocketRelayState.Closed) {
					settled = true;
					this.#emitter.off("state", onStateChange);
					this.#clearTimer(timer);
					reject(new Error("WebSocketRelayPort.awaitOpen: port closed before opening"));
				}
			};
			const timer = this.#setTimer(() => {
				if (settled) return;
				settled = true;
				this.#emitter.off("state", onStateChange);
				reject(
					new Error(
						`WebSocketRelayPort.awaitOpen: not open within ${timeoutMs}ms (state=${this.#state})`,
					),
				);
			}, timeoutMs);
			this.#emitter.on("state", onStateChange);
		});
	}

	/** Open the connection. Idempotent — calling while already Open / Connecting / Reconnecting is a no-op. */
	connect(): void {
		if (this.#disposed) return;
		if (
			this.#state === WebSocketRelayState.Open ||
			this.#state === WebSocketRelayState.Connecting ||
			this.#state === WebSocketRelayState.Reconnecting
		) {
			return;
		}
		this.#openSocket();
	}

	subscribe(entityId: string): void {
		if (this.#disposed) return;
		if (!entityId) throw new Error("WebSocketRelayPort.subscribe: empty entityId");
		const fresh = !this.#subscriptions.has(entityId);
		this.#subscriptions.add(entityId);
		if (fresh && this.#state === WebSocketRelayState.Open) {
			this.#sendControl({ op: "subscribe", entityIds: [entityId], bundle: true });
		}
	}

	/**
	 * 10.10 — subscribe MANY routing keys at once (the fresh-device bootstrap
	 * path: the restore engine passes the whole catalog). One chunked control
	 * message per {@link SUBSCRIBE_BATCH_MAX} fresh ids instead of one per
	 * entity, each advertising `bundle:true` so a durable node replies with
	 * bundled backfill (`0x03`) instead of one message per frame. Already-
	 * subscribed ids are skipped; an old node ignores the flag and streams
	 * per-frame — the client needs no negotiation, both inbound shapes apply
	 * identically.
	 */
	subscribeBatch(entityIds: readonly string[]): void {
		if (this.#disposed) return;
		const fresh: string[] = [];
		for (const entityId of entityIds) {
			if (!entityId || this.#subscriptions.has(entityId)) continue;
			this.#subscriptions.add(entityId);
			fresh.push(entityId);
		}
		if (fresh.length === 0 || this.#state !== WebSocketRelayState.Open) return;
		for (let i = 0; i < fresh.length; i += SUBSCRIBE_BATCH_MAX) {
			this.#sendControl({
				op: "subscribe",
				entityIds: fresh.slice(i, i + SUBSCRIBE_BATCH_MAX),
				bundle: true,
			});
		}
	}

	unsubscribe(entityId: string): void {
		if (this.#disposed) return;
		const had = this.#subscriptions.delete(entityId);
		if (had && this.#state === WebSocketRelayState.Open) {
			this.#sendControl({ op: "unsubscribe", entityIds: [entityId] });
		}
	}

	subscriptionsSnapshot(): readonly string[] {
		return [...this.#subscriptions];
	}

	/**
	 * Stage 10.14 — request the durable node's catalog for `account` (the
	 * device's wire `sender`, base64url): the account's entity ids joined with
	 * the latest snapshot version the node holds. The cold-restore consumer
	 * uses this to enumerate what to fetch. Resolves on the node's
	 * `catalog-result` control reply; rejects if the relay isn't Open or the
	 * reply doesn't arrive within the timeout. A second request for the same
	 * account while one is in flight shares the first's outcome.
	 *
	 * Catalog is plaintext routing metadata (the node already records it from
	 * the wire header) — no DEK, no entity content crosses here.
	 */
	requestCatalog(account: string): Promise<CatalogEntry[]> {
		if (this.#disposed) {
			return Promise.reject(new Error("WebSocketRelayPort.requestCatalog: port is closed"));
		}
		if (!account) {
			return Promise.reject(new Error("WebSocketRelayPort.requestCatalog: empty account"));
		}
		if (this.#state !== WebSocketRelayState.Open) {
			return Promise.reject(
				new Error(`WebSocketRelayPort.requestCatalog: relay not open (state=${this.#state})`),
			);
		}
		const inflight = this.#pendingCatalog.get(account);
		if (inflight) return inflight.promise;
		let resolve!: (entries: CatalogEntry[]) => void;
		let reject!: (error: Error) => void;
		const promise = new Promise<CatalogEntry[]>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		const timer = this.#setTimer(() => {
			const pending = this.#pendingCatalog.get(account);
			if (!pending) return;
			this.#pendingCatalog.delete(account);
			pending.reject(
				new Error(`WebSocketRelayPort.requestCatalog: no reply within ${this.#catalogTimeoutMs}ms`),
			);
		}, this.#catalogTimeoutMs);
		this.#pendingCatalog.set(account, { resolve, reject, timer, promise });
		this.#sendControl({ op: "catalog", account });
		return promise;
	}

	/**
	 * Stage 10.11 — ask the durable node to re-home routing `from → to`
	 * (storage migration + dual-token grace alias). Resolves on the node's
	 * `rotated` ack; rejects on `rotate-denied`, timeout, or a not-open port.
	 * FAIL-CLOSED CONTRACT: the caller (the rotation coordinator) flips
	 * emission to `to` ONLY after this resolves — a pre-10.11 node silently
	 * ignores the verb, this times out, and the old token stays in use. The
	 * node-side migration is idempotent, so re-sending after a crash/timeout
	 * converges. A second request for the same `from` while one is in flight
	 * shares its outcome (same `to`) or rejects (different `to`).
	 */
	requestRotate(from: string, to: string, account?: string): Promise<void> {
		if (this.#disposed) {
			return Promise.reject(new Error("WebSocketRelayPort.requestRotate: port is closed"));
		}
		if (!from || !to || from === to) {
			return Promise.reject(new Error("WebSocketRelayPort.requestRotate: invalid from/to"));
		}
		if (this.#state !== WebSocketRelayState.Open) {
			return Promise.reject(
				new Error(`WebSocketRelayPort.requestRotate: relay not open (state=${this.#state})`),
			);
		}
		const inflight = this.#pendingRotate.get(from);
		if (inflight) {
			return inflight.to === to
				? inflight.promise
				: Promise.reject(
						new Error(
							`WebSocketRelayPort.requestRotate: rotation of ${from} already in flight to a different token`,
						),
					);
		}
		let resolve!: () => void;
		let reject!: (error: Error) => void;
		const promise = new Promise<void>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		const timer = this.#setTimer(() => {
			const pending = this.#pendingRotate.get(from);
			if (!pending) return;
			this.#pendingRotate.delete(from);
			pending.reject(
				new Error(`WebSocketRelayPort.requestRotate: no reply within ${this.#rotateTimeoutMs}ms`),
			);
		}, this.#rotateTimeoutMs);
		this.#pendingRotate.set(from, { to, resolve, reject, timer, promise });
		this.#sendControl({ op: "rotate", from, to, ...(account ? { account } : {}) });
		return promise;
	}

	/**
	 * Asset-B4 — send one blob-plane request frame (an `AssetWireKind`
	 * HAS/PUT/GET, already built by the caller's `WireAssetCas`) on the asset
	 * channel and resolve with the node's response frame. Serialized: each call
	 * waits for the prior to settle so exactly one request is in flight and the
	 * single inbound response correlates to it (no per-request id needed). Unlike
	 * `send`, an asset request is NOT queued offline — it rejects if the socket
	 * isn't Open (the caller, the asset transport, retries the chunk later).
	 *
	 * This is the WS binding the Asset-B2 client transport deferred: pass
	 * `(frame) => port.requestAsset(frame)` as a `WireAssetCas` transport.
	 */
	requestAsset(frame: Uint8Array): Promise<Uint8Array> {
		if (this.#disposed)
			return Promise.reject(new Error("WebSocketRelayPort.requestAsset: port is closed"));
		return new Promise<Uint8Array>((resolve, reject) => {
			this.#assetQueue.push({ frame: new Uint8Array(frame), resolve, reject });
			this.#pumpAsset();
		});
	}

	/** Send the next queued asset request if none is in flight. Sends
	 *  synchronously so the request is on the wire before the caller can `close`;
	 *  the inbound response (or timeout / close) settles it and pumps the next. */
	#pumpAsset(): void {
		if (this.#pendingAsset) return;
		const next = this.#assetQueue.shift();
		if (!next) return;
		if (
			this.#disposed ||
			this.#state !== WebSocketRelayState.Open ||
			!this.#ws ||
			this.#ws.readyState !== OPEN_READY_STATE
		) {
			next.reject(new Error("WebSocketRelayPort.requestAsset: port not open"));
			this.#pumpAsset();
			return;
		}
		const timer = this.#setTimer(() => {
			this.#settleAsset((p) =>
				p.reject(
					new Error(`WebSocketRelayPort.requestAsset: no reply within ${this.#assetTimeoutMs}ms`),
				),
			);
		}, this.#assetTimeoutMs);
		this.#pendingAsset = { resolve: next.resolve, reject: next.reject, timer };
		const wire = new Uint8Array(1 + next.frame.length);
		wire[0] = ASSET_CHANNEL_BYTE;
		wire.set(next.frame, 1);
		try {
			this.#ws.send(wire);
		} catch (error) {
			this.#settleAsset((p) =>
				p.reject(
					error instanceof Error ? error : new Error("WebSocketRelayPort.requestAsset: send failed"),
				),
			);
		}
	}

	/** Settle the in-flight asset request (clearing its timer) and pump the
	 *  next. A no-op if nothing is in flight (e.g. a late/stale response). */
	#settleAsset(
		settle: (p: { resolve: (f: Uint8Array) => void; reject: (e: Error) => void }) => void,
	): void {
		const pending = this.#pendingAsset;
		if (!pending) return;
		this.#pendingAsset = null;
		this.#clearTimer(pending.timer);
		settle(pending);
		this.#pumpAsset();
	}

	/**
	 * Enqueue an opaque `EncryptedFrame` for delivery. The first byte sent
	 * on the wire is the `FRAME_CHANNEL_BYTE`; the rest is the frame
	 * payload unchanged.
	 */
	send(frame: Uint8Array): void {
		if (this.#disposed) {
			throw new Error("WebSocketRelayPort.send: port is closed");
		}
		const wire = wrapBinaryFrame(frame);
		if (
			this.#state === WebSocketRelayState.Open &&
			this.#ws &&
			this.#ws.readyState === OPEN_READY_STATE
		) {
			try {
				this.#ws.send(wire);
				return;
			} catch {
				// Fall through to queue — the socket is wedging; reconnect
				// will flush as soon as it can.
			}
		}
		this.#enqueueOutbound(wire);
	}

	onFrame(cb: (frame: Uint8Array) => void): void {
		this.#listeners.add(cb);
	}

	offFrame(cb: (frame: Uint8Array) => void): void {
		this.#listeners.delete(cb);
	}

	/** Terminate the connection and free resources. Idempotent. */
	close(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#clearReconnect();
		this.#rejectAllCatalog("WebSocketRelayPort: port closed");
		this.#rejectAllRotate("WebSocketRelayPort: port closed");
		this.#rejectPendingAsset("WebSocketRelayPort: port closed");
		this.#sendQueue = [];
		const ws = this.#ws;
		this.#ws = null;
		this.#listeners.clear();
		this.#subscriptions.clear();
		if (ws) {
			try {
				ws.close();
			} catch {
				// Already-closed sockets are noisy on some impls; the port
				// is done with this handle either way.
			}
		}
		this.#transition(WebSocketRelayState.Closed);
		this.#emitter.removeAllListeners();
	}

	#openSocket(): void {
		this.#clearReconnect();
		this.#transition(WebSocketRelayState.Connecting);
		let ws: WebSocketLike;
		try {
			ws = new this.#wsImpl(this.#url);
		} catch (error) {
			this.#onSocketError(error);
			return;
		}
		// WHATWG WebSocket (browser, Node 22+ globalThis.WebSocket, Bun) defaults
		// `binaryType` to `"blob"`, which the inbound dispatcher's
		// `toUint8Array` doesn't recognise — every received frame silently
		// drops as `droppedInbound`. The soak harness's two-instance pairing
		// hand-off failed for exactly this reason (10.9d step 2 root cause):
		// the source's listener never fired for the target's JoinRequest
		// because the frame never made it past the channel-byte decode.
		// Setting `arraybuffer` makes `event.data` an `ArrayBuffer` that
		// `toUint8Array` handles directly. Best-effort because the fake-WS
		// constructor used by tests doesn't carry the setter.
		(ws as { binaryType?: string }).binaryType = "arraybuffer";
		this.#ws = ws;
		ws.onopen = () => this.#onSocketOpen();
		ws.onclose = () => this.#onSocketClose();
		ws.onerror = (event) => this.#onSocketError(event);
		ws.onmessage = (event) => this.#onSocketMessage(event);
	}

	#onSocketOpen(): void {
		if (this.#disposed) return;
		this.#openedAtMs = this.#now();
		// A fresh socket is unauthenticated until the node's `auth-ok` lands.
		this.#gatedAdmission = false;
		this.#transition(WebSocketRelayState.Open);
		// Re-emit every active subscription so the relay's routing table
		// re-builds after a reconnect. `bundle:true` lets a durable node serve
		// the re-backfill bundled (10.10) — an old node ignores it.
		if (this.#subscriptions.size > 0) {
			this.#sendControl({ op: "subscribe", entityIds: [...this.#subscriptions], bundle: true });
		}
		// Drain any frames queued while connecting / reconnecting.
		this.#flushSendQueue();
	}

	#onSocketClose(): void {
		if (this.#disposed) return;
		this.#ws = null;
		// If the connection held Open for ≥ 30s, reset the attempt counter
		// so a long-lived stable link doesn't punish a later reconnect.
		if (this.#openedAtMs !== null && this.#now() - this.#openedAtMs >= STABLE_OPEN_RESET_MS) {
			this.#attempt = 0;
		}
		this.#openedAtMs = null;
		this.#scheduleReconnect();
	}

	#onSocketError(_error: unknown): void {
		if (this.#disposed) return;
		// We never propagate errors to the producer — the reconnect path
		// is the contract. We do flip state for one tick so observers can
		// surface a warning; the subsequent `Reconnecting` transition is
		// what tells 10.7's panel "we'll come back".
		this.#transition(WebSocketRelayState.Error);
	}

	#onSocketMessage(event: { data: unknown }): void {
		if (this.#disposed) return;
		const data = event.data;
		const bytes = toUint8Array(data);
		if (!bytes || bytes.length < 1) {
			this.#droppedInbound += 1;
			return;
		}
		const channel = bytes[0];
		if (channel === FRAME_CHANNEL_BYTE) {
			const frame = bytes.subarray(1);
			// Defensive copy so a listener mutating the buffer doesn't see
			// (or cause) writes through the WebSocket's underlying buffer.
			const copy = new Uint8Array(frame);
			this.#dispatchFrame(copy);
			return;
		}
		if (channel === BUNDLE_CHANNEL_BYTE) {
			// 10.10 — bundled backfill: unpack and fan each sub-frame through the
			// SAME listener path as a `0x01` message, so downstream apply is
			// byte-identical to the unbundled stream. A malformed bundle is
			// rejected wholly (never a partial apply of a corrupt message).
			const frames = decodeBundlePayload(bytes.subarray(1));
			if (!frames) {
				this.#droppedInbound += 1;
				return;
			}
			for (const frame of frames) this.#dispatchFrame(frame);
			return;
		}
		if (channel === ASSET_CHANNEL_BYTE) {
			// Asset-B4 — the response to the one in-flight `requestAsset` (FIFO:
			// requests are serialized, so the head pending resolver is this reply).
			if (!this.#pendingAsset) this.#droppedInbound += 1;
			const response = new Uint8Array(bytes.subarray(1));
			this.#settleAsset((p) => p.resolve(response));
			return;
		}
		if (channel === CONTROL_CHANNEL_BYTE) {
			// Server→client control messages this client acts on: `catalog-result`
			// (the reply to `requestCatalog`), and the SYNC-4b gated handshake
			// (`challenge` → respond with `auth`; `auth-ok` → (re)send subs).
			// Anything else is tolerated + dropped so a forward-compat server can
			// ship more without breaking this client.
			const result = decodeCatalogResult(bytes);
			if (result) {
				this.#resolveCatalog(result);
				return;
			}
			const rotateReply = decodeRotateReply(bytes);
			if (rotateReply) {
				this.#settleRotate(rotateReply);
				return;
			}
			const op = decodeControlOp(bytes);
			if (op === "challenge") {
				const nonce = decodeChallengeNonce(bytes);
				if (nonce) this.#respondToChallenge(nonce);
				return;
			}
			if (op === "auth-ok") {
				this.#onAuthenticated();
				return;
			}
			return;
		}
		this.#droppedInbound += 1;
	}

	/** Deliver one inbound frame to every listener (a listener throwing must
	 *  not block fan-out to siblings). The frame must already be a safe copy. */
	#dispatchFrame(frame: Uint8Array): void {
		for (const listener of this.#listeners) {
			try {
				listener(frame);
			} catch {
				// A listener throwing must not block fan-out to siblings.
			}
		}
	}

	#scheduleReconnect(): void {
		if (this.#disposed) return;
		this.#transition(WebSocketRelayState.Reconnecting);
		const delay = this.#nextBackoff();
		this.#attempt += 1;
		this.#reconnectHandle = this.#setTimer(() => {
			this.#reconnectHandle = null;
			if (this.#disposed) return;
			this.#openSocket();
		}, delay);
	}

	#clearReconnect(): void {
		if (this.#reconnectHandle !== null) {
			this.#clearTimer(this.#reconnectHandle);
			this.#reconnectHandle = null;
		}
	}

	#nextBackoff(): number {
		const i = Math.min(this.#attempt, BACKOFF_SCHEDULE_MS.length - 1);
		const base = BACKOFF_SCHEDULE_MS[i] ?? BACKOFF_SCHEDULE_MS[BACKOFF_SCHEDULE_MS.length - 1];
		const baseMs = base ?? 30_000;
		const jitter = (this.#random() * 2 - 1) * JITTER_FRACTION * baseMs;
		return Math.max(0, Math.round(baseMs + jitter));
	}

	#resolveCatalog(result: CatalogResultMessage): void {
		const pending = this.#pendingCatalog.get(result.account);
		if (!pending) return;
		this.#pendingCatalog.delete(result.account);
		this.#clearTimer(pending.timer);
		pending.resolve(result.entities);
	}

	/** Stage 10.11 — settle the in-flight rotate matching this reply. A reply
	 *  whose `to` doesn't match the pending request is ignored (stale/forged
	 *  replies can't flip the coordinator). */
	#settleRotate(reply: RotatedMessage | RotateDeniedMessage): void {
		const pending = this.#pendingRotate.get(reply.from);
		if (!pending || pending.to !== reply.to) return;
		this.#pendingRotate.delete(reply.from);
		this.#clearTimer(pending.timer);
		if (reply.op === "rotated") {
			pending.resolve();
		} else {
			pending.reject(new Error(`WebSocketRelayPort.requestRotate: denied (${reply.reason})`));
		}
	}

	/** SYNC-4b — answer a gated node's challenge: compute the auth payload via
	 *  the injected (crypto-aware) callback and send it back. No callback (no
	 *  credentials) ⇒ stay silent; the node's auth deadline closes us and the
	 *  reconnect path retries (an open node never challenges in the first place). */
	#respondToChallenge(nonce: string): void {
		if (!this.#onChallenge) return;
		void this.#onChallenge(nonce)
			.then((response) => {
				if (!response || this.#disposed) return;
				this.#sendControl({ op: "auth", ...response });
			})
			.catch(() => {
				// A signing/token failure leaves us unauthenticated; the node closes
				// + we reconnect. Never throw into the socket callback.
			});
	}

	/** SYNC-4b — admitted: (re)send subscriptions + flush queued frames, since a
	 *  gated node dropped anything sent before the handshake completed. */
	#onAuthenticated(): void {
		if (this.#disposed) return;
		this.#gatedAdmission = true;
		if (this.#subscriptions.size > 0) {
			this.#sendControl({ op: "subscribe", entityIds: [...this.#subscriptions], bundle: true });
		}
		this.#flushSendQueue();
	}

	#rejectAllCatalog(reason: string): void {
		for (const [, pending] of this.#pendingCatalog) {
			this.#clearTimer(pending.timer);
			pending.reject(new Error(reason));
		}
		this.#pendingCatalog.clear();
	}

	#rejectAllRotate(reason: string): void {
		for (const [, pending] of this.#pendingRotate) {
			this.#clearTimer(pending.timer);
			pending.reject(new Error(reason));
		}
		this.#pendingRotate.clear();
	}

	#rejectPendingAsset(reason: string): void {
		const pending = this.#pendingAsset;
		if (pending) {
			this.#pendingAsset = null;
			this.#clearTimer(pending.timer);
			pending.reject(new Error(reason));
		}
		const queued = this.#assetQueue.splice(0);
		for (const q of queued) q.reject(new Error(reason));
	}

	#sendControl(message: RelayControlMessage): void {
		const json = JSON.stringify(message);
		const body = new TextEncoder().encode(json);
		const wire = new Uint8Array(1 + body.length);
		wire[0] = CONTROL_CHANNEL_BYTE;
		wire.set(body, 1);
		if (this.#ws && this.#ws.readyState === OPEN_READY_STATE) {
			try {
				this.#ws.send(wire);
				return;
			} catch {
				// Drop on the floor — the socket is wedging; reconnect
				// re-emits subscriptions on next open. Control messages
				// are NOT queued (we always re-send the full subscription
				// set on connect; queuing would duplicate).
			}
		}
	}

	#enqueueOutbound(wire: Uint8Array): void {
		if (this.#sendQueue.length >= SEND_QUEUE_CAP) {
			this.#sendQueue.shift();
			this.#droppedSends += 1;
		}
		this.#sendQueue.push(wire);
	}

	#flushSendQueue(): void {
		if (!this.#ws || this.#ws.readyState !== OPEN_READY_STATE) return;
		const queued = this.#sendQueue;
		this.#sendQueue = [];
		for (const wire of queued) {
			try {
				this.#ws.send(wire);
			} catch {
				// Re-enqueue what we couldn't push; the reconnect path
				// will get the next crack.
				this.#enqueueOutbound(wire);
			}
		}
	}

	#transition(next: WebSocketRelayState): void {
		if (this.#state === next) return;
		this.#state = next;
		this.#emitter.emit("state", next);
	}
}

export function wrapBinaryFrame(frame: Uint8Array): Uint8Array {
	const out = new Uint8Array(1 + frame.length);
	out[0] = FRAME_CHANNEL_BYTE;
	out.set(frame, 1);
	return out;
}

export function unwrapBinaryFrame(wire: Uint8Array): Uint8Array | null {
	if (wire.length < 1 || wire[0] !== FRAME_CHANNEL_BYTE) return null;
	return wire.subarray(1);
}

export function encodeControlMessage(message: RelayControlMessage): Uint8Array {
	const json = JSON.stringify(message);
	const body = new TextEncoder().encode(json);
	const out = new Uint8Array(1 + body.length);
	out[0] = CONTROL_CHANNEL_BYTE;
	out.set(body, 1);
	return out;
}

export function decodeControlMessage(wire: Uint8Array): RelayControlMessage | null {
	if (wire.length < 1 || wire[0] !== CONTROL_CHANNEL_BYTE) return null;
	const json = new TextDecoder().decode(wire.subarray(1));
	try {
		const parsed = JSON.parse(json) as unknown;
		if (!isControlMessage(parsed)) return null;
		return parsed;
	} catch {
		return null;
	}
}

export function isControlMessage(value: unknown): value is RelayControlMessage {
	if (!value || typeof value !== "object") return false;
	const v = value as {
		op?: unknown;
		entityIds?: unknown;
		account?: unknown;
		token?: unknown;
		sig?: unknown;
		from?: unknown;
		to?: unknown;
	};
	if (v.op === "catalog") return typeof v.account === "string" && v.account.length > 0;
	if (v.op === "rotate") {
		return (
			typeof v.from === "string" &&
			v.from.length > 0 &&
			typeof v.to === "string" &&
			v.to.length > 0 &&
			v.from !== v.to &&
			(v.account === undefined || (typeof v.account === "string" && v.account.length > 0))
		);
	}
	if (v.op === "auth") {
		return (
			typeof v.token === "string" &&
			v.token.length > 0 &&
			typeof v.account === "string" &&
			v.account.length > 0 &&
			typeof v.sig === "string" &&
			v.sig.length > 0
		);
	}
	if (v.op !== "subscribe" && v.op !== "unsubscribe") return false;
	if (!Array.isArray(v.entityIds)) return false;
	if (v.op === "subscribe" && "bundle" in v && (v as { bundle?: unknown }).bundle !== true) {
		return false;
	}
	return v.entityIds.every((e) => typeof e === "string" && e.length > 0);
}

/**
 * 10.10 — encode many opaque wire frames into one bundle payload (the bytes
 * after the `0x03` channel byte): repeated `u32-be(len) || frameBytes`, no
 * count prefix — the lengths must consume the payload exactly. Pure framing;
 * each sub-frame stays the opaque ciphertext envelope it always was. Mirrors
 * `brainstorm-sync`'s `encodeBundlePayload` (the node is the producer on the
 * live path; this encoder exists for tests + the loopback-free contract).
 */
export function encodeBundlePayload(frames: readonly Uint8Array[]): Uint8Array | null {
	if (frames.length === 0) return null;
	let total = 0;
	for (const frame of frames) {
		if (frame.length === 0) return null;
		total += 4 + frame.length;
	}
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	let offset = 0;
	for (const frame of frames) {
		view.setUint32(offset, frame.length, false);
		offset += 4;
		out.set(frame, offset);
		offset += frame.length;
	}
	return out;
}

/**
 * 10.10 — strict decode of a bundle payload. Returns null on ANY deviation
 * (empty payload, truncated length prefix, zero-length sub-frame, a length
 * that over/underruns the payload) so a corrupt message is dropped wholly —
 * never a partial apply. Each returned sub-frame is a copy, safe to hand to
 * listeners that outlive the socket buffer.
 */
export function decodeBundlePayload(payload: Uint8Array): Uint8Array[] | null {
	if (payload.length === 0) return null;
	const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
	const frames: Uint8Array[] = [];
	let offset = 0;
	while (offset < payload.length) {
		if (offset + 4 > payload.length) return null;
		const len = view.getUint32(offset, false);
		offset += 4;
		if (len === 0) return null;
		if (offset + len > payload.length) return null;
		frames.push(new Uint8Array(payload.subarray(offset, offset + len)));
		offset += len;
	}
	return frames;
}

/** SYNC-4b — read the `op` of a server→client control frame (challenge/auth-ok),
 *  or null if it isn't a control frame / valid JSON object. */
function decodeControlOp(wire: Uint8Array): string | null {
	if (wire.length < 1 || wire[0] !== CONTROL_CHANNEL_BYTE) return null;
	try {
		const parsed = JSON.parse(new TextDecoder().decode(wire.subarray(1))) as unknown;
		if (!parsed || typeof parsed !== "object") return null;
		const op = (parsed as { op?: unknown }).op;
		return typeof op === "string" ? op : null;
	} catch {
		return null;
	}
}

/** SYNC-4b — extract the nonce from a `challenge` control frame, or null. */
function decodeChallengeNonce(wire: Uint8Array): string | null {
	if (wire.length < 1 || wire[0] !== CONTROL_CHANNEL_BYTE) return null;
	try {
		const parsed = JSON.parse(new TextDecoder().decode(wire.subarray(1))) as unknown;
		if (!parsed || typeof parsed !== "object") return null;
		const v = parsed as { op?: unknown; nonce?: unknown };
		if (v.op !== "challenge" || typeof v.nonce !== "string" || v.nonce.length === 0) return null;
		return v.nonce;
	} catch {
		return null;
	}
}

/** Stage 10.14 — decode a server→client `catalog-result` control message.
 *  Returns null for any non-`catalog-result` control frame or malformed JSON. */
export function decodeCatalogResult(wire: Uint8Array): CatalogResultMessage | null {
	if (wire.length < 1 || wire[0] !== CONTROL_CHANNEL_BYTE) return null;
	try {
		const parsed = JSON.parse(new TextDecoder().decode(wire.subarray(1))) as unknown;
		if (!parsed || typeof parsed !== "object") return null;
		const v = parsed as { op?: unknown; account?: unknown; entities?: unknown };
		if (v.op !== "catalog-result") return null;
		if (typeof v.account !== "string") return null;
		if (!Array.isArray(v.entities)) return null;
		const entities: CatalogEntry[] = [];
		for (const e of v.entities) {
			if (!e || typeof e !== "object") return null;
			const entry = e as { entityId?: unknown; version?: unknown };
			if (typeof entry.entityId !== "string" || typeof entry.version !== "number") return null;
			entities.push({ entityId: entry.entityId, version: entry.version });
		}
		return { op: "catalog-result", account: v.account, entities };
	} catch {
		return null;
	}
}

/** Stage 10.11 — decode a server→client `rotated` / `rotate-denied` control
 *  message. Returns null for any other control frame or malformed JSON. */
export function decodeRotateReply(wire: Uint8Array): RotatedMessage | RotateDeniedMessage | null {
	if (wire.length < 1 || wire[0] !== CONTROL_CHANNEL_BYTE) return null;
	try {
		const parsed = JSON.parse(new TextDecoder().decode(wire.subarray(1))) as unknown;
		if (!parsed || typeof parsed !== "object") return null;
		const v = parsed as { op?: unknown; from?: unknown; to?: unknown; reason?: unknown };
		if (typeof v.from !== "string" || v.from.length === 0) return null;
		if (typeof v.to !== "string" || v.to.length === 0) return null;
		if (v.op === "rotated") return { op: "rotated", from: v.from, to: v.to };
		if (v.op === "rotate-denied") {
			return typeof v.reason === "string"
				? { op: "rotate-denied", from: v.from, to: v.to, reason: v.reason }
				: null;
		}
		return null;
	} catch {
		return null;
	}
}

function toUint8Array(data: unknown): Uint8Array | null {
	if (data instanceof Uint8Array) return data;
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) {
		const view = data as ArrayBufferView;
		return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
	}
	return null;
}
