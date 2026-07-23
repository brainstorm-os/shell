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
import type { WebSocketCtor, WebSocketLike } from "./websocket-relay-port";

const CONTROL_CHANNEL_BYTE = 0x00;

/** Host-side admission decision. `nonce` is the exact string the host issued in
 *  the `challenge`; the verifier decodes + checks the signature over it. */
export type LanAdmit = (account: string, sig: string, nonce: string) => boolean | Promise<boolean>;

export type LanRelayHostOptions = {
	/** Roster-verified admission callback (from `lan-admission.ts`). Absent ⇒
	 *  OPEN host (no challenge) — cloud-relay parity, tests only. When present the
	 *  host challenges every connection and admits only on a true result. */
	admit?: LanAdmit;
	/** Injected nonce source (relay-blind: no `node:crypto` import). Default =
	 *  32 random bytes (Web Crypto global) base64url-encoded. */
	mintNonce?: () => string;
	/** Deterministic connection ids for tests. */
	mintConnId?: () => string;
	now?: () => number;
};

type AdmissionState = {
	authed: boolean;
	nonce: string;
};

/** Minimal control shapes the host reads/writes. Opaque JSON — the host never
 *  looks past `op` / the auth fields; it does NOT parse routing headers. */
type AuthControl = { op: "auth"; token?: string; account?: string; sig?: string };

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
	readonly #admit: LanAdmit | null;
	readonly #mintNonce: () => string;
	readonly #admission = new Map<string, AdmissionState>();
	#closed = false;

	constructor(opts: LanRelayHostOptions = {}) {
		this.#admit = opts.admit ?? null;
		this.#mintNonce = opts.mintNonce ?? defaultMintNonce;
		this.#core = createRelayCore({
			...(opts.mintConnId ? { mintConnId: opts.mintConnId } : {}),
			...(opts.now ? { now: opts.now } : {}),
		});
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
	_onOpen(serverWs: ServerWebSocketLike, sendToClient: (wire: Uint8Array) => void): string {
		const connId = this.#core.handlers.onOpen(serverWs);
		if (this.#admit) {
			const nonce = this.#mintNonce();
			this.#admission.set(connId, { authed: false, nonce });
			sendToClient(encodeControl({ op: "challenge", nonce }));
		} else {
			this.#admission.set(connId, { authed: true, nonce: "" });
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
		if (!state.authed) {
			// Only an `auth` control can move an unauthenticated connection forward.
			const auth =
				bytes.length >= 1 && bytes[0] === CONTROL_CHANNEL_BYTE ? decodeAuth(bytes.subarray(1)) : null;
			if (!auth) return; // drop subscribe / frame / anything else pre-auth.
			void this.#tryAdmit(connId, state, auth, sendToClient, closeClient);
			return;
		}
		// Authenticated: hand off to the blind router (subscribe / unsubscribe /
		// frame fan-out). The host never parses past the channel byte here.
		this.#core.handlers.onMessage(serverWs, bytes);
	}

	/** Deregister a closed connection. */
	_onClose(serverWs: ServerWebSocketLike): void {
		const connId = serverWs.data?.connId;
		this.#core.handlers.onClose(serverWs);
		if (connId) this.#admission.delete(connId);
	}

	async #tryAdmit(
		connId: string,
		state: AdmissionState,
		auth: AuthControl,
		sendToClient: (wire: Uint8Array) => void,
		closeClient: () => void,
	): Promise<void> {
		const admit = this.#admit;
		if (!admit) return;
		let ok = false;
		try {
			ok = await admit(auth.account ?? "", auth.sig ?? "", state.nonce);
		} catch {
			ok = false;
		}
		// The connection may have closed while the async verify was in flight.
		if (this.#closed || !this.#admission.has(connId)) return;
		if (ok) {
			state.authed = true;
			sendToClient(encodeControl({ op: "auth-ok" }));
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
			this.#host._onOpen(this.#serverWs, (wire) => this.#serverWs.send(wire));
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
