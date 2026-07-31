/**
 * LAN-1 — embedded blind relay HOST for same-network sync (the "no server"
 * wedge). Wraps `@brainstorm-os/relay-server`'s `createRelayCore` (the exact
 * blind fan-out that backs the cloud relay) so one paired peer can host the
 * fan-out on the LAN and the other connects to it with the unchanged
 * `WebSocketRelayPort`. The entire sealed CRDT + awareness + pairing pipeline
 * rides it untouched.
 *
 * ⚠️ NOT SHIPPABLE FROM THIS PASS. This host exposes only an IN-PROCESS client
 * factory (`webSocketCtor()`) — the localhost / in-process proof. Binding a
 * REAL external LAN socket (Bun.serve / `ws`) is deliberately NOT implemented
 * here; it is withheld behind the mandatory `/security-review` + `/pentester`
 * on the `connect → challenge → verify-roster → admit → subscribe → route`
 * path (see `docs/data/lan-p2p-sync.md` §4). Opening a network-reachable
 * listener is the shell's first inbound socket and must not land un-reviewed.
 *
 * RELAY-BLIND. This file's basename contains `relay` and it lives under
 * `sync/`, so it inherits the CI fence
 * (`tools/mcp-server/src/tools/relay-noble-import-check.ts`): zero `@noble/*`
 * and zero `envelope-seal/crypto` imports. Peer authentication is CRYPTO and
 * lives in the injected `admit(...)` callback (built by the non-blind
 * `lan-admission.ts`); this host only routes opaque bytes and shuttles the
 * challenge/auth control strings.
 *
 * Admission handshake (host side of SYNC-4b, which the `WebSocketRelayPort`
 * client already speaks):
 *   1. on connect, if an `admit` callback is configured, send
 *      `{op:"challenge", nonce}` and hold the connection UNAUTHENTICATED
 *      (drop every subscribe / frame) until it proves itself;
 *   2. on `{op:"auth", account, sig}`, call `admit(account, sig, nonce)`
 *      (roster + signature check, in `lan-admission.ts`); on true, mark
 *      authenticated and send `{op:"auth-ok"}`; on false, close the socket;
 *   3. an authenticated connection's frames/subscribes flow to the blind
 *      `FrameRouter` unchanged. With no `admit` configured the host is OPEN
 *      (no challenge) — parity with the cloud relay, for tests only.
 */

import { Buffer } from "node:buffer";
import {
	type RelayCore,
	type ServerWebSocketLike,
	createRelayCore,
} from "../../../../relay-server/src/server";
import type { LanHostHandshake } from "./lan-admission";
import { type WebSocketCtor, type WebSocketLike, decodePingStamp } from "./websocket-relay-port";

const CONTROL_CHANNEL_BYTE = 0x00;

/** Host-side admission decision. `nonce` is the exact string the host issued in
 *  the `challenge`; the verifier decodes + checks the signature over it. */
export type LanAdmit = (account: string, sig: string, nonce: string) => boolean | Promise<boolean>;

export type LanRelayHostOptions = {
	/** Channel-bound handshake (LAN-2b(b), gate finding G2) — the relay-proof
	 *  path. When present the host waits for the client's `hello`, seals the
	 *  nonce to that device's X25519 key, verifies the returned proof and
	 *  answers with its OWN proof. Takes precedence over `admit`. */
	handshake?: LanHostHandshake;
	/** This host's device account, announced in the sealed challenge so the
	 *  client can bind the AAD and check the host is itself rostered. */
	hostAccount?: string;
	/** Legacy plaintext-nonce admission (roster + signature only, no channel
	 *  binding). Kept for the cloud-parity tests; a LAN wiring must use
	 *  `handshake` — a plaintext challenge is relay-forgeable. Absent ⇒
	 *  OPEN host (no challenge) — cloud-relay parity, tests only. When present the
	 *  host challenges every connection and admits only on a true result. */
	admit?: LanAdmit;
	/** Injected nonce source (relay-blind: no `node:crypto` import). Default =
	 *  32 random bytes (Web Crypto global) base64url-encoded. */
	mintNonce?: () => string;
	/** Deterministic connection ids for tests. */
	mintConnId?: () => string;
	now?: () => number;
	/** Close a connection that hasn't proven itself within this window
	 *  (gate finding G9 — an unauthenticated socket used to be held FOREVER,
	 *  so an unpaired LAN peer could pin connections and memory with no crypto
	 *  and no roster membership). */
	authDeadlineMs?: number;
	/** Refuse a new connection beyond this many live ones (G9). */
	maxConnections?: number;
	/** Drop any single client→host message larger than this (G9). A sealed
	 *  update is orders of magnitude smaller; this bounds the per-message copy
	 *  an admitted-or-not peer can force. */
	maxMessageBytes?: number;
	/** Max routing keys one connection may hold (G7). */
	maxSubscriptions?: number;
	/** Timer seam so tests drive the deadline without real time. */
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
};

/** Close an unproven connection after 5s — long enough for a slow device to
 *  sign a nonce, far short of anything an idle attacker can exploit. */
export const DEFAULT_LAN_AUTH_DEADLINE_MS = 5_000;
/** Two paired devices need 2 (the host's own loopback client + the guest);
 *  the headroom covers reconnect overlap without inviting a flood. */
export const DEFAULT_LAN_MAX_CONNECTIONS = 16;
/** 8 MiB — comfortably above any real sealed frame, well below a memory DoS. */
export const DEFAULT_LAN_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

type AdmissionState = {
	authed: boolean;
	nonce: string;
	/** Raw nonce bytes for the channel-bound path (the sealed challenge carries
	 *  them encrypted; the host keeps the plaintext to verify the proof). */
	nonceBytes: Uint8Array | null;
	/** The account named in `hello`, set before the challenge is sealed. */
	clientAccount: string | null;
	/** One admission attempt per connection (G9): a second `auth` control is
	 *  refused rather than queued, so a single socket cannot drive unbounded
	 *  concurrent signature verifies against a never-rotated nonce. */
	attempted: boolean;
	/** Auth-deadline handle, cleared on admit / close. */
	deadline: unknown;
};

/** Minimal control shapes the host reads/writes. Opaque JSON — the host never
 *  looks past `op` / the auth fields; it does NOT parse routing headers. */
type AuthControl = { op: "auth"; token?: string; account?: string; sig?: string };

/** G7 — bound how many routing keys one connection may join. LAN peers are all
 *  devices in ONE vault's roster and already hold the DEKs, so key-level
 *  authorization buys nothing there (see the doc's OQ-LAN-9 resolution); this
 *  cap exists purely so a peer cannot grow the host's routing table without
 *  limit. */
export const DEFAULT_LAN_MAX_SUBSCRIPTIONS = 4096;

function defaultMintNonce(): string {
	const bytes = new Uint8Array(32);
	(globalThis.crypto as Crypto).getRandomValues(bytes);
	return Buffer.from(bytes).toString("base64url");
}

/**
 * Embedded blind relay host. Construct once on the electing peer (see
 * `electLanRole`); hand `host.webSocketCtor()` to a `WebSocketRelayPort` as its
 * `wsImpl` so the peer's own loopback client AND — under the future real-socket
 * binding — a guest connect through the same admission + routing core.
 */
export class LanRelayHost {
	readonly #core: RelayCore;
	readonly #handshake: LanHostHandshake | null;
	readonly #hostAccount: string | null;
	readonly #admit: LanAdmit | null;
	readonly #mintNonce: () => string;
	readonly #admission = new Map<string, AdmissionState>();
	readonly #authDeadlineMs: number;
	readonly #maxConnections: number;
	readonly #maxMessageBytes: number;
	readonly #maxSubscriptions: number;
	readonly #setTimer: (fn: () => void, ms: number) => unknown;
	readonly #clearTimer: (handle: unknown) => void;
	#closed = false;

	constructor(opts: LanRelayHostOptions = {}) {
		this.#handshake = opts.handshake ?? null;
		this.#hostAccount = opts.hostAccount ?? null;
		this.#admit = opts.admit ?? null;
		this.#mintNonce = opts.mintNonce ?? defaultMintNonce;
		this.#authDeadlineMs = opts.authDeadlineMs ?? DEFAULT_LAN_AUTH_DEADLINE_MS;
		this.#maxConnections = opts.maxConnections ?? DEFAULT_LAN_MAX_CONNECTIONS;
		this.#maxMessageBytes = opts.maxMessageBytes ?? DEFAULT_LAN_MAX_MESSAGE_BYTES;
		this.#maxSubscriptions = opts.maxSubscriptions ?? DEFAULT_LAN_MAX_SUBSCRIPTIONS;
		this.#setTimer =
			opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms) as unknown as ReturnType<typeof setTimeout>);
		this.#clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
		this.#core = createRelayCore({
			...(opts.mintConnId ? { mintConnId: opts.mintConnId } : {}),
			...(opts.now ? { now: opts.now } : {}),
		});
	}

	/** Fresh nonce BYTES for the channel-bound path (the sealed challenge needs
	 *  the raw value; the legacy path needs the base64url string). */
	#mintNonceBytes(): Uint8Array {
		return base64UrlToBytesLocal(this.#mintNonce());
	}

	/** The host account the challenge announces, so the client knows which
	 *  device to bind the AAD to (and can check it is rostered). */
	#handshakeHostAccount(): string {
		return this.#hostAccount ?? "";
	}

	/** The routing/audit core — test-visible for asserting fan-out + that the
	 *  audit log carries zero plaintext (frames are AEAD ciphertext). */
	get core(): RelayCore {
		return this.#core;
	}

	/** Live (admitted or open) connection count. */
	connectionCount(): number {
		return this.#core.connections.size;
	}

	/**
	 * A `WebSocketCtor` a `WebSocketRelayPort` uses as its `wsImpl`. Every `new`
	 * opens a fresh in-process connection bound to this host: client→host bytes
	 * reach the host's message pump; host→client bytes arrive on `onmessage`.
	 * This is the localhost / in-process transport; the real external-socket
	 * binding is withheld behind the security review (see file header).
	 */
	webSocketCtor(): WebSocketCtor {
		const host = this;
		return class LanClientSocket extends LanHostConnection {
			constructor(_url: string) {
				super(host);
			}
		};
	}

	/** Tear the host down: close every live connection + clear admission state. */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const [, ws] of [...this.#core.connections]) {
			try {
				ws.close();
			} catch {
				// already-closed sockets are noisy on some impls — ignore.
			}
		}
		this.#admission.clear();
	}

	// --- connection lifecycle (called by LanHostConnection) -----------------

	/** Register a freshly-opened connection. Returns its connId. Challenges when
	 *  an `admit` callback is configured; otherwise the connection is open. */
	_onOpen(
		serverWs: ServerWebSocketLike,
		sendToClient: (wire: Uint8Array) => void,
		closeClient?: () => void,
	): string | null {
		// G9 — refuse beyond the ceiling rather than accepting unboundedly.
		if (this.#core.connections.size >= this.#maxConnections) {
			closeClient?.();
			return null;
		}
		const connId = this.#core.handlers.onOpen(serverWs);
		console.info(`[lan-host] connection accepted (${this.#core.connections.size} live)`);
		if (this.#handshake || this.#admit) {
			const nonce = this.#mintNonce();
			const state: AdmissionState = {
				authed: false,
				nonce,
				nonceBytes: null,
				clientAccount: null,
				attempted: false,
				deadline: null,
			};
			// G9 — an unproven connection is reaped, not held forever.
			state.deadline = this.#setTimer(() => {
				const live = this.#admission.get(connId);
				if (!live || live.authed) return;
				closeClient?.();
			}, this.#authDeadlineMs);
			this.#admission.set(connId, state);
			// Channel-bound path: say nothing until the client names itself in
			// `hello` — the challenge is sealed TO that device's X25519 key, so
			// there is nothing to send before we know who is connecting.
			if (!this.#handshake) sendToClient(encodeControl({ op: "challenge", nonce }));
		} else {
			this.#admission.set(connId, {
				authed: true,
				nonce: "",
				nonceBytes: null,
				clientAccount: null,
				attempted: true,
				deadline: null,
			});
		}
		return connId;
	}

	/** Route one client→host message. Enforces admission: while unauthenticated,
	 *  only an `auth` control is honored; every subscribe / frame is dropped. */
	_onMessage(
		serverWs: ServerWebSocketLike,
		bytes: Uint8Array,
		sendToClient: (wire: Uint8Array) => void,
		closeClient: () => void,
	): void {
		if (this.#closed) return;
		const connId = serverWs.data?.connId;
		if (!connId) return;
		const state = this.#admission.get(connId);
		if (!state) return;
		// G9 — bound the per-message copy any peer can force, admitted or not.
		if (bytes.length > this.#maxMessageBytes) return;
		if (!state.authed) {
			const control =
				bytes.length >= 1 && bytes[0] === CONTROL_CHANNEL_BYTE ? bytes.subarray(1) : null;
			if (!control) return; // drop subscribe / frame / anything else pre-auth.

			// Channel-bound path (LAN-2b(b)): `hello` names the connecting device
			// so the challenge can be SEALED to its roster X25519 key.
			if (this.#handshake && state.clientAccount === null) {
				const hello = decodeHello(control);
				if (!hello) {
					console.warn("[lan-host] pre-auth message was not a usable hello — ignoring");
					return;
				}
				const nonceBytes = this.#mintNonceBytes();
				const sealed = this.#handshake.sealFor(hello.account, nonceBytes);
				// Unknown, revoked, or no usable X25519 key ⇒ close. There is NO
				// fallback to a plaintext challenge: that would be a downgrade an
				// attacker could force by presenting an old-shaped roster row.
				if (!sealed) {
					// Refusing is right; refusing SILENTLY is what made a failed LAN
					// dial undiagnosable — the peer just saw its connect deadline
					// expire. Only a key prefix is logged, never the whole account.
					console.warn(
						`[lan-host] no sealed challenge for ${hello.account.slice(0, 12)}… — not in this device's roster, revoked, or no usable X25519 key`,
					);
					closeClient();
					return;
				}
				state.clientAccount = hello.account;
				state.nonceBytes = nonceBytes;
				sendToClient(
					encodeControl({ op: "challenge", account: this.#handshakeHostAccount(), ...sealed }),
				);
				return;
			}

			const auth = decodeAuth(control);
			if (!auth) return;
			// G9 — exactly one attempt per connection: a second `auth` is refused
			// rather than queued, so one socket can't drive unbounded concurrent
			// verifies against a nonce that never rotates.
			if (state.attempted) return;
			state.attempted = true;
			void this.#tryAdmit(connId, state, auth, sendToClient, closeClient);
			return;
		}
		// P2P-1 — answer the transport keepalive. Admitted-only, on purpose: a
		// peer that has proven nothing gets no reply of any kind, so `ping` is
		// not a pre-auth liveness oracle for scanning the LAN. The stamp is
		// echoed verbatim and nothing else is read, so this carries no routing
		// metadata and the host stays blind.
		if (bytes.length >= 1 && bytes[0] === CONTROL_CHANNEL_BYTE) {
			const stamp = decodePingStamp(bytes);
			if (stamp !== null) {
				sendToClient(encodeControl({ op: "pong", t: stamp }));
				return;
			}
		}
		// G6 — the LAN host does NOT serve `rotate`. `applyRotation` has no
		// ownership check on `from`, so an admitted peer could migrate every
		// subscriber of someone else's routing key onto its own — undetectable
		// interception. The design already says LAN has "NO requestRotate", but
		// that only removed the CLIENT method; the verb was still served. Routing
		// tokens are a durable-node concern and there is no durable node on LAN,
		// so the verb is simply not offered here.
		if (
			bytes.length >= 1 &&
			bytes[0] === CONTROL_CHANNEL_BYTE &&
			isRotateControl(bytes.subarray(1))
		) {
			return;
		}
		// G7 — cap how many routing keys ONE connection may hold. Key-level
		// authorization is deliberately NOT enforced (see the OQ-LAN-9
		// resolution: every LAN peer is a device in the same vault's roster and
		// already holds the DEKs, so restricting WHICH keys it may join buys no
		// confidentiality). The cap is purely so a peer cannot grow the host's
		// routing table without bound.
		if (bytes.length >= 1 && bytes[0] === CONTROL_CHANNEL_BYTE) {
			const joining = countSubscribeKeys(bytes.subarray(1));
			if (joining > 0) {
				const held = this.#core.router.connectionEntities(connId).length;
				if (held + joining > this.#maxSubscriptions) return;
			}
		}
		// Authenticated: hand off to the blind router (subscribe / unsubscribe /
		// frame fan-out). The host never parses past the channel byte here.
		this.#core.handlers.onMessage(serverWs, bytes);
		// LAN-7 — a peer that JUST joined a channel has nothing; the peers already
		// there hold the only copy of the history. Nudge them to re-emit so the
		// joiner catches up on its own. LAN-6 proved backfill WORKS, but only when
		// a test drove it by hand; this is what makes it automatic.
		//
		// Routing metadata only — the key is the same opaque token the router
		// already fans out on, so the host stays blind.
		if (bytes.length >= 1 && bytes[0] === CONTROL_CHANNEL_BYTE) {
			const body = bytes.subarray(1);
			this.#notifyResync(connId, decodeSubscribeKeys(body), decodeSubscribeStateVectors(body));
		}
	}

	/** Deregister a closed connection. */
	_onClose(serverWs: ServerWebSocketLike): void {
		const connId = serverWs.data?.connId;
		this.#core.handlers.onClose(serverWs);
		if (connId) {
			const state = this.#admission.get(connId);
			if (state?.deadline) this.#clearTimer(state.deadline);
			this.#admission.delete(connId);
		}
	}

	/** Ask every EXISTING subscriber of each key to re-emit, so the connection
	 *  that just joined gets caught up. The joiner is excluded — it has nothing
	 *  to offer yet. */
	#notifyResync(
		joinerConnId: string,
		keys: readonly string[],
		stateVectors: Readonly<Record<string, string>> = {},
	): void {
		for (const key of keys) {
			const existing = this.#core.router.subscribersFor(key, joinerConnId);
			if (existing.length === 0) continue;
			// LAN-8 — carry the joiner's state vector so the emitter can send only
			// what that peer is MISSING instead of the whole document. The value is
			// an opaque base64 string here: the host does not decode it, so this
			// stays inside the relay-blind fence exactly like the routing key.
			const sv = stateVectors[key];
			const wire = encodeControl(sv ? { op: "resync", key, sinceSv: sv } : { op: "resync", key });
			for (const connId of existing) {
				const ws = this.#core.connections.get(connId);
				if (!ws) continue;
				try {
					ws.send(wire);
				} catch {
					// A failed write must not stop the others (the router's own
					// fan-out has the same posture).
				}
			}
		}
	}

	async #tryAdmit(
		connId: string,
		state: AdmissionState,
		auth: AuthControl,
		sendToClient: (wire: Uint8Array) => void,
		closeClient: () => void,
	): Promise<void> {
		const handshake = this.#handshake;
		const admit = this.#admit;
		if (!handshake && !admit) return;
		let ok = false;
		try {
			if (handshake) {
				// The account is the one bound into the sealed challenge — NOT
				// whatever this message claims, so a client cannot switch identity
				// between `hello` and `auth`.
				ok =
					state.clientAccount !== null &&
					state.nonceBytes !== null &&
					handshake.verifyClient(state.clientAccount, auth.sig ?? "", state.nonceBytes);
			} else if (admit) {
				ok = await admit(auth.account ?? "", auth.sig ?? "", state.nonce);
			}
		} catch {
			ok = false;
		}
		// The connection may have closed while the async verify was in flight.
		// Compare STATE IDENTITY, not just presence (G11): `mintConnId` is
		// injectable, so a wiring supplying non-unique ids would otherwise let a
		// stale continuation mark a *new* connection authenticated.
		if (this.#closed || this.#admission.get(connId) !== state) return;
		if (!ok) {
			console.warn(
				`[lan-host] refused ${(state.clientAccount ?? "unknown").slice(0, 12)}… — the challenge answer did not verify`,
			);
		}
		if (ok) {
			// The host proves ITSELF back before the client sends anything —
			// without this the client has no way to tell a rostered host from a
			// rogue one that merely said "auth-ok" (gate finding G2).
			let proof: string | null = null;
			if (handshake) {
				proof =
					state.clientAccount && state.nonceBytes
						? handshake.proveToClient(state.clientAccount, state.nonceBytes)
						: null;
				if (!proof) {
					closeClient();
					return;
				}
			}
			state.authed = true;
			if (state.deadline) {
				this.#clearTimer(state.deadline);
				state.deadline = null;
			}
			sendToClient(encodeControl(proof ? { op: "auth-ok", proof } : { op: "auth-ok" }));
		} else {
			closeClient();
		}
	}
}

/**
 * One in-process connection between a `WebSocketRelayPort` (client) and a
 * `LanRelayHost`. Implements the `WebSocketLike` surface the client drives, and
 * mirrors real-WebSocket timing by crossing a macrotask boundary on every hop
 * (so the client can wire `onopen`/`onmessage` before they fire).
 */
class LanHostConnection implements WebSocketLike {
	readyState = 0; // Connecting until open fires.
	binaryType?: string;
	onopen: ((ev?: unknown) => void) | null = null;
	onclose: ((ev?: unknown) => void) | null = null;
	onerror: ((ev?: unknown) => void) | null = null;
	onmessage: ((ev: { data: unknown }) => void) | null = null;

	readonly #host: LanRelayHost;
	readonly #serverWs: ServerWebSocketLike;

	constructor(host: LanRelayHost) {
		this.#host = host;
		const self = this;
		this.#serverWs = {
			send(data: Uint8Array | string): void {
				if (!(data instanceof Uint8Array)) return;
				const copy = new Uint8Array(data);
				setTimeout(() => self.onmessage?.({ data: copy }), 0);
			},
			close(): void {
				self.#serverClose();
			},
			data: {},
		};
		setTimeout(() => {
			if (this.readyState !== 0) return;
			this.readyState = 1;
			const connId = this.#host._onOpen(
				this.#serverWs,
				(wire) => this.#serverWs.send(wire),
				() => this.#serverClose(),
			);
			// Refused at the connection ceiling — never signal `open`.
			if (connId === null) {
				this.readyState = 3;
				setTimeout(() => this.onclose?.(), 0);
				return;
			}
			this.onopen?.();
		}, 0);
	}

	send(data: Uint8Array): void {
		if (this.readyState !== 1) return;
		const copy = new Uint8Array(data);
		setTimeout(() => {
			this.#host._onMessage(
				this.#serverWs,
				copy,
				(wire) => this.#serverWs.send(wire),
				() => this.#serverClose(),
			);
		}, 0);
	}

	close(): void {
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.#host._onClose(this.#serverWs);
		setTimeout(() => this.onclose?.(), 0);
	}

	/** Host-initiated close (admission denied / host teardown). */
	#serverClose(): void {
		if (this.readyState === 3) return;
		this.readyState = 3;
		this.#host._onClose(this.#serverWs);
		setTimeout(() => this.onclose?.(), 0);
	}
}

function encodeControl(message: Record<string, unknown>): Uint8Array {
	const body = new TextEncoder().encode(JSON.stringify(message));
	const wire = new Uint8Array(1 + body.length);
	wire[0] = CONTROL_CHANNEL_BYTE;
	wire.set(body, 1);
	return wire;
}

/** Is this control body a `rotate` request? Reads only `op` — the host stays
 *  blind to everything else (same posture as `decodeAuth`). */
function isRotateControl(body: Uint8Array): boolean {
	try {
		const parsed = JSON.parse(new TextDecoder().decode(body)) as { op?: unknown };
		return !!parsed && typeof parsed === "object" && parsed.op === "rotate";
	} catch {
		return false;
	}
}

/** The routing keys a `subscribe` control is joining (empty for anything else).
 *  Opaque tokens — the host never interprets them, it only needs to know who to
 *  nudge (LAN-7). */
function decodeSubscribeKeys(body: Uint8Array): string[] {
	try {
		const v = JSON.parse(new TextDecoder().decode(body)) as {
			op?: unknown;
			entityIds?: unknown;
		};
		if (v?.op !== "subscribe" || !Array.isArray(v.entityIds)) return [];
		return v.entityIds.filter((k): k is string => typeof k === "string" && k.length > 0);
	} catch {
		return [];
	}
}

/** Per-key state vectors a `subscribe` may advertise (LAN-8), as opaque base64.
 *  Absent ⇒ the emitter falls back to a full snapshot, which is what LAN-6/7
 *  already did — so an old client keeps working. */
function decodeSubscribeStateVectors(body: Uint8Array): Record<string, string> {
	try {
		const v = JSON.parse(new TextDecoder().decode(body)) as {
			op?: unknown;
			stateVectors?: unknown;
		};
		if (v?.op !== "subscribe" || !v.stateVectors || typeof v.stateVectors !== "object") return {};
		const out: Record<string, string> = {};
		for (const [key, sv] of Object.entries(v.stateVectors as Record<string, unknown>)) {
			if (typeof sv === "string" && sv.length > 0) out[key] = sv;
		}
		return out;
	} catch {
		return {};
	}
}

/** How many routing keys a `subscribe` control is asking for (0 for anything
 *  else). Reads only the array length — the host stays blind to the keys. */
function countSubscribeKeys(body: Uint8Array): number {
	try {
		const v = JSON.parse(new TextDecoder().decode(body)) as {
			op?: unknown;
			entityIds?: unknown;
		};
		if (v?.op !== "subscribe" || !Array.isArray(v.entityIds)) return 0;
		return v.entityIds.length;
	} catch {
		return 0;
	}
}

/** `hello{account}` — the first control on a channel-bound connection. Reads
 *  only the account string; the host stays blind to everything else. */
function decodeHello(body: Uint8Array): { account: string } | null {
	try {
		const parsed = JSON.parse(new TextDecoder().decode(body)) as {
			op?: unknown;
			account?: unknown;
		};
		if (!parsed || typeof parsed !== "object") return null;
		if (parsed.op !== "hello") return null;
		if (typeof parsed.account !== "string" || parsed.account.length === 0) return null;
		return { account: parsed.account };
	} catch {
		return null;
	}
}

/** base64url → bytes, local so this file keeps its zero-crypto import surface
 *  (a base64 decode is not crypto; importing the pairing module here would drag
 *  a crypto-adjacent module into the relay-blind fence). */
function base64UrlToBytesLocal(encoded: string): Uint8Array {
	return new Uint8Array(Buffer.from(encoded, "base64url"));
}

function decodeAuth(body: Uint8Array): AuthControl | null {
	try {
		const parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
		if (!parsed || typeof parsed !== "object") return null;
		const v = parsed as { op?: unknown; account?: unknown; sig?: unknown; token?: unknown };
		if (v.op !== "auth") return null;
		if (typeof v.account !== "string" || v.account.length === 0) return null;
		if (typeof v.sig !== "string" || v.sig.length === 0) return null;
		return {
			op: "auth",
			account: v.account,
			sig: v.sig,
			...(typeof v.token === "string" ? { token: v.token } : {}),
		};
	} catch {
		return null;
	}
}
