/**
 * LAN-4b — the shell's FIRST INBOUND LISTENING SOCKET.
 *
 * Everything else in the LAN track has been in-process. This is the module that
 * actually binds a port other machines can reach, so it is the one the security
 * gate was written for (`docs/_review/2026-07-26-lan-p2p-security-gate.md`).
 * It does as little as possible: accept a socket, adapt it to the shape
 * `LanRelayHost` already speaks, and enforce the limits that only exist once
 * there is a real peer address to count.
 *
 * **RELAY-BLIND.** The basename contains `relay` and it lives under `sync/`, so
 * it inherits the CI fence (`relay-noble-import-check`) — zero crypto imports.
 * That naming is deliberate and load-bearing: gate finding G12 noted that a
 * module called `lan-listener.ts` would NOT be fenced. All admission crypto
 * stays behind the injected handshake in `lan-admission.ts`.
 *
 * **Interface selection (T1).** Binds to a SPECIFIC address, never `0.0.0.0`.
 * A wildcard bind exposes the port on every interface the machine has —
 * including a public one on a laptop with a routable address. `lanInterfaces()`
 * enumerates only private/link-local IPv4 so the caller cannot accidentally
 * pick a public one.
 *
 * **Lifecycle (T8).** `start()` / `stop()` are explicit and idempotent; the
 * wiring ties them to "a LAN-shared entity is open" so the port is not
 * listening at idle. A permanently-open port is a permanently-open attack
 * surface, and firewall prompts train users to click allow.
 */

import { type IncomingMessage, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { WebSocketServer } from "ws";
import type { LanRelayHost } from "./lan-relay-host";

/** A bindable local address: private IPv4 (RFC1918) or link-local. */
export type LanInterface = { name: string; address: string };

/**
 * Addresses this machine may bind a LAN listener to. Deliberately excludes
 * loopback (a peer can't reach it) and anything public — a listener on a
 * routable address is an internet-facing service, which is emphatically not
 * what "sync on my local network" means.
 */
export function lanInterfaces(): LanInterface[] {
	const out: LanInterface[] = [];
	for (const [name, addrs] of Object.entries(networkInterfaces())) {
		for (const addr of addrs ?? []) {
			if (addr.family !== "IPv4" || addr.internal) continue;
			if (isPrivateIpv4(addr.address)) out.push({ name, address: addr.address });
		}
	}
	return out;
}

/**
 * Collapse the IPv4-mapped IPv6 form to its IPv4 spelling. A dual-stack accept
 * reports `::ffff:10.0.0.5` while the same host over IPv4 reports `10.0.0.5`;
 * keying the rate limiter on the raw string would hand one peer two
 * independent budgets. Exported so the collapse is testable on its own — it is
 * the whole correctness of the limit.
 */
export function normalizeSourceAddress(raw: string): string {
	const lower = raw.trim().toLowerCase();
	return lower.startsWith("::ffff:") ? lower.slice("::ffff:".length) : lower;
}

/**
 * May we bind here? Private or loopback IPv4 literals only.
 *
 * Loopback is allowed so tests can bind without touching a real interface;
 * everything else must satisfy `isPrivateIpv4`. Anything that is not a
 * four-octet literal — a hostname, `0`, `0x0`, `::0`, a trailing dot — is
 * refused, because those are exactly the forms that resolved to a wildcard.
 */
export function isBindableAddress(address: string): boolean {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address.trim());
	if (!m) return false;
	const octets = m.slice(1, 5).map(Number);
	if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
	if (octets[0] === 127) return true; // loopback — test/local host client
	return isPrivateIpv4(address.trim());
}

function isPrivateIpv4(address: string): boolean {
	const parts = address.split(".").map(Number);
	if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
		return false;
	}
	const [a, b] = parts as [number, number, number, number];
	if (a === 10) return true;
	if (a === 192 && b === 168) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 169 && b === 254) return true; // link-local
	return false;
}

/** How many connections one source address may open within the window. The
 *  in-process host already caps TOTAL connections; this is the per-source half
 *  of gate finding G9, which needs a real peer address to enforce at all. */
export const DEFAULT_LAN_RATE_LIMIT = 10;
export const DEFAULT_LAN_RATE_WINDOW_MS = 10_000;
/** Refuse an oversized frame at the socket edge, before it is buffered. */
export const DEFAULT_LAN_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
/** A peer has 5s to send request headers, 10s to finish the request. Node's
 *  defaults are minutes — far too generous for a listener whose callers have
 *  proven nothing yet. */
export const DEFAULT_LAN_HEADERS_TIMEOUT_MS = 5_000;
export const DEFAULT_LAN_REQUEST_TIMEOUT_MS = 10_000;
/** Ceiling on raw TCP sockets, upgraded or not. */
export const DEFAULT_LAN_MAX_SOCKETS = 64;
/** Slots kept free for sources not already connected, so a flooder that fills
 *  the rest cannot deny the feature to a fresh legitimate device (L4). */
export const RESERVED_FOR_FRESH_SOURCES = 8;
/** Unread outbound bytes tolerated per connection before it is dropped (L5).
 *  A few MiB absorbs a normal burst; beyond it the peer is not reading. */
export const DEFAULT_LAN_MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export type LanRelayListenerOptions = {
	host: LanRelayHost;
	/** Address to bind. MUST be a specific interface — see the T1 note. */
	address: string;
	/** 0 ⇒ let the OS pick a free high port (the default; a fixed port is a
	 *  stable target and buys nothing when the address is exchanged at pair
	 *  time anyway). */
	port?: number;
	maxConnectionsPerSource?: number;
	rateWindowMs?: number;
	maxPayloadBytes?: number;
	/** Reap a socket that connects but never completes request headers. */
	headersTimeoutMs?: number;
	requestTimeoutMs?: number;
	/** Ceiling on TCP sockets regardless of upgrade state — the pre-upgrade
	 *  phase must not be able to outflank the host's post-upgrade cap. */
	maxSockets?: number;
	/** Drop a connection whose unread outbound queue exceeds this (L5). */
	maxBufferedBytes?: number;
	/** Post-listen server errors (the socket is up, something went wrong). The
	 *  wiring routes these to the shell's error log; unset ⇒ swallowed, never
	 *  re-thrown, because an unhandled emitter error takes down the main
	 *  process. */
	onError?: (err: Error) => void;
	now?: () => number;
};

/** A bound listener. `url` is exactly what goes in the pairing payload's
 *  `relayUrl` slot (LAN-3). */
export type LanListenerAddress = { address: string; port: number; url: string };

export class LanRelayListener {
	readonly #opts: Required<Omit<LanRelayListenerOptions, "host" | "port" | "onError">> &
		Pick<LanRelayListenerOptions, "host" | "port">;
	#http: Server | null = null;
	#wss: WebSocketServer | null = null;
	#bound: LanListenerAddress | null = null;
	/** In-flight `start()`, so concurrent callers share one bind (L6). */
	#starting: Promise<LanListenerAddress> | null = null;
	readonly #onError: ((err: Error) => void) | null;
	/** source address → recent connection timestamps (rate limiting). */
	readonly #recent = new Map<string, number[]>();
	/** Live sockets per source, incremented on accept and decremented on close.
	 *  Distinct from `#recent` (a RATE window): this is concurrency, which is
	 *  what actually starves the accept queue. */
	readonly #liveBySource = new Map<string, number>();

	constructor(opts: LanRelayListenerOptions) {
		if (!isBindableAddress(opts.address ?? "")) {
			// An ALLOWLIST, not a wildcard blocklist. The first version compared
			// against "0.0.0.0" and "::" and was trivially bypassed — the pentest
			// bound `"0"`, `"::0"`, `"0x0"` and `"0.0.0.0."` and reached the port
			// off-loopback on the machine's real LAN address. A blocklist also
			// cannot express "not a public address": a hostname or a routable
			// literal sailed through. So: must parse as an IPv4 LITERAL (never a
			// name the resolver gets to interpret) and be private or loopback.
			throw new Error(
				"LanRelayListener: address must be a private or loopback IPv4 literal, not a wildcard or hostname",
			);
		}
		this.#onError = opts.onError ?? null;
		this.#opts = {
			host: opts.host,
			address: opts.address,
			...(opts.port !== undefined ? { port: opts.port } : {}),
			maxConnectionsPerSource: opts.maxConnectionsPerSource ?? DEFAULT_LAN_RATE_LIMIT,
			rateWindowMs: opts.rateWindowMs ?? DEFAULT_LAN_RATE_WINDOW_MS,
			maxPayloadBytes: opts.maxPayloadBytes ?? DEFAULT_LAN_MAX_PAYLOAD_BYTES,
			headersTimeoutMs: opts.headersTimeoutMs ?? DEFAULT_LAN_HEADERS_TIMEOUT_MS,
			requestTimeoutMs: opts.requestTimeoutMs ?? DEFAULT_LAN_REQUEST_TIMEOUT_MS,
			maxSockets: opts.maxSockets ?? DEFAULT_LAN_MAX_SOCKETS,
			maxBufferedBytes: opts.maxBufferedBytes ?? DEFAULT_LAN_MAX_BUFFERED_BYTES,
			now: opts.now ?? Date.now,
		};
	}

	/** The bound address, or null when not listening. */
	address(): LanListenerAddress | null {
		return this.#bound;
	}

	/** Bind and start accepting. Idempotent — a second call returns the address
	 *  already bound rather than opening a second port. */
	async start(): Promise<LanListenerAddress> {
		if (this.#bound) return this.#bound;
		// L6/L9 — memoize the IN-FLIGHT start. The old guard checked `#bound`,
		// which is only assigned AFTER the await, so two un-awaited calls in one
		// tick opened TWO ports; the second won `#bound` and the first was
		// ORPHANED — still listening, still adopting real peers onto the host,
		// with no reference left to close it. `stop()` then reported success
		// while a port stayed open, which is exactly the "not listening at idle"
		// property (T8) the header claims. The wiring is event-driven ("a shared
		// entity is open"), which is precisely the shape that produces two calls
		// in one tick.
		if (this.#starting) return this.#starting;
		this.#starting = this.#startOnce().finally(() => {
			this.#starting = null;
		});
		return this.#starting;
	}

	async #startOnce(): Promise<LanListenerAddress> {
		// A plain HTTP request must get a definite answer and be closed. Found by
		// probing this listener: with no request handler the connection HUNG
		// FOREVER — no response, no timeout — and the rate limiter never saw it,
		// because that only fires on a WebSocket `connection`. So any LAN host
		// could hold unlimited un-upgraded sockets against us with no roster
		// membership and no crypto: pre-auth exhaustion (T1/T7) through the one
		// door the admission machinery doesn't cover.
		const http = createServer((_req, res) => {
			// L10 — EMPTY body. It used to answer "brainstorm-lan: websocket only",
			// which told any LAN port scan that this machine runs Brainstorm with
			// LAN sync live. A bare 426 + Connection: close still closes the
			// pre-upgrade hole (the reason this handler exists) and leaks nothing.
			res.writeHead(426, { connection: "close" }); // Upgrade Required
			res.end();
		});
		// Reap sockets that connect and then stall without completing a request
		// (the raw-TCP variant of the same attack — it never reaches the handler
		// above). Node's defaults are minutes; on a LAN listener that is far too
		// generous for a peer that has proven nothing.
		http.headersTimeout = this.#opts.headersTimeoutMs;
		http.requestTimeout = this.#opts.requestTimeoutMs;
		// Hard ceiling on TCP sockets regardless of upgrade state, so the
		// pre-upgrade phase cannot outflank the host's post-upgrade cap.
		http.maxConnections = this.#opts.maxSockets;
		// `headersTimeout` alone is NOT enough: probing showed 10/10 raw TCP
		// sockets that connect and send nothing surviving well past it (the
		// runtime does not always honour it, and a security control must not
		// depend on that). So reap them explicitly — every socket gets a
		// handshake deadline, cleared the moment it upgrades.
		//
		// The clear-on-upgrade half is essential: an established WebSocket is
		// long-lived and often idle, so leaving an inactivity timeout armed
		// would kill healthy peers.
		//
		// ⚠️ RUNTIME NOTE — this defense is NOT covered by the test suite. Bun's
		// `node:http` shim never emits `connection` at all (measured: 0 events),
		// so under `bun --bun vitest` stalled sockets are not reaped and a test
		// asserting they are would fail for a reason that does not exist in
		// production. Verified directly under Node instead — `connection events:
		// 5 | closed by server: 5` — which is the runtime Electron actually uses.
		// Re-check this by hand under Node if the hook ever changes.
		const upgraded = new WeakSet<object>();
		http.on("upgrade", (_req, socket) => upgraded.add(socket));
		http.on("connection", (socket) => {
			// L4 bookkeeping at the ACCEPT layer — before any upgrade, which is
			// where the starvation happened.
			const src = normalizeSourceAddress(socket.remoteAddress ?? "");
			if (src) {
				this.#liveBySource.set(src, (this.#liveBySource.get(src) ?? 0) + 1);
				socket.once("close", () => {
					const n = (this.#liveBySource.get(src) ?? 1) - 1;
					if (n <= 0) this.#liveBySource.delete(src);
					else this.#liveBySource.set(src, n);
				});
			}
			// An EXPLICIT timer, not `socket.setTimeout` and not
			// `headersTimeout`: probing showed 0 of 10 stalled sockets reaped by
			// either. A security control cannot rest on timer semantics that vary
			// by runtime, so this owns its own deadline.
			//
			// Cleared once the socket upgrades — an established WebSocket is
			// long-lived and often idle, so a deadline left armed would kill
			// healthy peers.
			const timer = setTimeout(() => {
				if (!upgraded.has(socket)) socket.destroy();
			}, this.#opts.headersTimeoutMs);
			if (typeof (timer as { unref?: () => void }).unref === "function") {
				(timer as { unref: () => void }).unref();
			}
			socket.once("close", () => clearTimeout(timer));
		});
		const wss = new WebSocketServer({
			server: http,
			maxPayload: this.#opts.maxPayloadBytes,
			// L7 + L8 — decide BEFORE the handshake. `connection` fires only after
			// `ws` has already parsed the request and sent `101`, so refusing there
			// cost a full handshake plus a `ws` object per attempt, at whatever
			// rate the attacker liked (measured: 50/50 refused sockets still open
			// at t+15s, gone only at t+31s on the close timeout).
			verifyClient: (info: { req: IncomingMessage }) =>
				shouldAcceptUpgrade(info.req.headers.origin, (source) => this.#admitSource(source), {
					remoteAddress: info.req.socket.remoteAddress,
				}),
			// No compression: permessage-deflate on attacker-influenced data is a
			// memory-amplification surface, and our frames are already sealed
			// (ciphertext does not compress).
			perMessageDeflate: false,
		});
		wss.on("connection", (socket, request) => {
			// FIRST, before any branch that might return: an unhandled 'error' on
			// a `ws` socket throws, and both refusal paths below used to hand back
			// a live socket with no listener attached. The pentest drove an
			// UNCAUGHT EXCEPTION IN THE SHELL MAIN PROCESS from an unpaired LAN
			// host with 11 connections and one malformed frame (RSV1 set). A
			// global uncaughtException handler existed, so it did not hard-kill —
			// it ran on post-exception, forwarded a flood to the renderer. Not a
			// defense worth relying on.
			socket.on("error", () => {
				// A socket-level error on a peer we may not even have adopted is
				// not actionable; adopted sockets get their real handler in #adopt.
			});
			// NOTE: the admission decision already ran in `verifyClient`, BEFORE
			// the 101 (L7). Re-running it here double-charged the rate budget —
			// every accepted socket consumed two slots, so a cap of 2 admitted
			// exactly one peer. Kept as a cheap belt-and-braces guard ONLY for the
			// case where a runtime ignores verifyClient; it must not consume
			// budget, so it reads the live counter rather than calling
			// `#allowSource` again.
			const source = normalizeSourceAddress(request.socket.remoteAddress ?? "");
			if (!source) {
				// terminate(), not close(): a graceful close lets a peer that
				// ignores the close frame keep the socket AND the `ws` object alive
				// for the 30s close timeout (measured: 50/50 refused sockets still
				// open at t+15s, gone only at t+31s).
				socket.terminate();
				return;
			}
			this.#adopt(socket);
		});
		this.#http = http;
		this.#wss = wss;

		// L2 — PERMANENT error handlers on BOTH emitters, installed before listen.
		// `new WebSocketServer({ server })` makes `ws` re-emit the http server's
		// 'error' on the WebSocketServer, which had no listener — so a bind
		// failure threw instead of rejecting. That is the ordinary laptop case,
		// not an exotic one: Wi-Fi flaps or the DHCP lease changes between
		// `lanInterfaces()` and `start()` and the address is simply gone
		// (EADDRNOTAVAIL), or the port is taken (EADDRINUSE). Post-listen server
		// errors took the same unhandled path.
		let rejectBind: ((err: Error) => void) | null = null;
		const onServerError = (err: Error): void => {
			const reject = rejectBind;
			rejectBind = null;
			if (reject) {
				reject(err);
				return;
			}
			this.#onError?.(err);
		};
		wss.on("error", onServerError);
		http.on("error", onServerError);

		await new Promise<void>((resolve, reject) => {
			rejectBind = reject;
			http.once("listening", () => {
				rejectBind = null;
				resolve();
			});
			http.listen(this.#opts.port ?? 0, this.#opts.address);
		});

		const info = http.address() as AddressInfo | null;
		if (!info) {
			await this.stop();
			throw new Error("LanRelayListener: bound but no address");
		}
		this.#bound = {
			address: info.address,
			port: info.port,
			url: `ws://${info.address}:${info.port}`,
		};
		return this.#bound;
	}

	/** Stop listening and drop every live connection. Idempotent. */
	async stop(): Promise<void> {
		// L6 — a start racing this would otherwise assign `#bound` (and leave a
		// live server) *after* we finished tearing down. Await it, then tear down
		// what it produced.
		if (this.#starting) {
			await this.#starting.catch(() => undefined);
		}
		const wss = this.#wss;
		const http = this.#http;
		this.#bound = null;
		this.#recent.clear();
		this.#liveBySource.clear();
		if (wss) {
			for (const client of wss.clients) {
				try {
					client.terminate();
				} catch {
					// Already-dead sockets are noisy; we're tearing down anyway.
				}
			}
			await closeBounded((done) => wss.close(done));
		}
		if (http) {
			// An UPGRADED socket keeps `close()` pending forever — its callback
			// waits for connections that a WebSocket, by design, never ends on its
			// own. Drop them explicitly first; without this, `stop()` hangs (it
			// did, and the listener tests timed out on exactly this).
			(http as { closeAllConnections?: () => void }).closeAllConnections?.();
			await closeBounded((done) => http.close(done));
		}
		// Cleared only NOW, after the closes settled. Nulling them up front (the
		// old order) meant a bounded-close timeout left a still-open server with
		// no reference to it — unreachable forever, and silent.
		this.#wss = null;
		this.#http = null;
	}

	/** G9 (per-source half) — bound how fast one address may reconnect. The
	 *  in-process host caps TOTAL connections; without this a single hostile
	 *  peer can churn through that budget and lock legitimate devices out. */
	/**
	 * L4 — accept-layer admission for ONE source, counting both the rate window
	 * and the live un-upgraded sockets that source is holding.
	 *
	 * `http.maxConnections` is global and cannot tell peers apart, so on its own
	 * it converts an unbounded-memory problem into a cheaper, more reliable
	 * denial of the whole feature: one unpaired host holding the ceiling in raw
	 * TCP sockets locked every legitimate device out (measured — a fresh peer got
	 * `ECONNRESET`). So a single source may never take more than its share, and
	 * `RESERVED_FOR_FRESH_SOURCES` slots stay free so an unknown-but-legitimate
	 * device can always land.
	 */
	#admitSource(source: string): boolean {
		if (!source) return false;
		const perSourceLive = this.#liveBySource.get(source) ?? 0;
		// `>` not `>=`: the socket being decided is ALREADY counted — the raw TCP
		// `connection` event fires before the HTTP upgrade reaches `verifyClient`.
		// With `>=` a source could only ever hold cap-1 sockets (measured: cap 2
		// admitted 1), which is a quiet, permanent under-provisioning of every
		// legitimate peer.
		if (perSourceLive > this.#opts.maxConnectionsPerSource) return false;
		// Headroom: past the reserve line, only sources we are ALREADY talking to
		// may take another slot — a flooder cannot consume the last few.
		const totalLive = [...this.#liveBySource.values()].reduce((n, v) => n + v, 0);
		if (totalLive >= this.#opts.maxSockets - RESERVED_FOR_FRESH_SOURCES && perSourceLive === 0) {
			return false;
		}
		return this.#allowSource(source);
	}

	#allowSource(rawSource: string): boolean {
		if (!rawSource) return false;
		const source = normalizeSourceAddress(rawSource);
		const now = this.#opts.now();
		const cutoff = now - this.#opts.rateWindowMs;
		// Evict every stale bucket, not just this source's: the map is keyed by
		// ATTACKER-CHOSEN addresses, so pruning only the current key lets a peer
		// with a subnet grow it without bound.
		for (const [key, times] of this.#recent) {
			const live = times.filter((t) => t > cutoff);
			if (live.length === 0) this.#recent.delete(key);
			else this.#recent.set(key, live);
		}
		const seen = this.#recent.get(source) ?? [];
		if (seen.length >= this.#opts.maxConnectionsPerSource) return false;
		seen.push(now);
		this.#recent.set(source, seen);
		return true;
	}

	/** Adapt one real socket onto the seams `LanRelayHost` already speaks, so
	 *  the admission state machine is IDENTICAL for in-process and real peers —
	 *  the localhost proof and the bound socket cannot drift apart. */
	#adopt(socket: {
		on: (event: string, cb: (...args: unknown[]) => void) => void;
		send: (data: Uint8Array) => void;
		close: () => void;
		terminate?: () => void;
		bufferedAmount?: number;
	}): void {
		const host = this.#opts.host;
		const serverWs = {
			send: (data: Uint8Array | string): void => {
				if (typeof data === "string") return;
				// L5 — outbound backpressure. The relay core fans out to every
				// subscriber unconditionally, and `ws` queues whatever the peer
				// has not read. A rostered-but-malicious device (or just a
				// suspended laptop) that stops reading turned that queue into the
				// HOST's memory: measured 86 MB grown by two sockets, one
				// subscribing and never reading while the other published 512 KiB
				// frames. Past the budget the connection is dropped rather than
				// buffered — a peer that cannot keep up is a dead peer, and
				// noticing that here is faster than the WS close timeout.
				const buffered = (socket as { bufferedAmount?: number }).bufferedAmount ?? 0;
				if (buffered > this.#opts.maxBufferedBytes) {
					try {
						socket.terminate?.();
					} catch {
						// Already gone.
					}
					return;
				}
				try {
					socket.send(data);
				} catch {
					// A dead socket is the close handler's problem.
				}
			},
			close: (): void => {
				try {
					socket.close();
				} catch {
					// Already closing.
				}
			},
			data: {} as { connId?: string },
		};
		const send = (wire: Uint8Array): void => serverWs.send(wire);
		const close = (): void => serverWs.close();

		const connId = host._onOpen(serverWs, send, close);
		if (connId === null) {
			// Refused at the host's connection ceiling.
			close();
			return;
		}
		socket.on("message", (...args: unknown[]) => {
			const raw = args[0];
			const bytes = toBytes(raw);
			if (!bytes) return;
			host._onMessage(serverWs, bytes, send, close);
		});
		socket.on("close", () => host._onClose(serverWs));
		socket.on("error", () => host._onClose(serverWs));
	}
}

/**
 * L8 — the pre-handshake accept decision, as a PURE function.
 *
 * `Origin` is the discriminator: a native peer never sends one, a browser always
 * does. WebSocket is exempt from CORS, so without this check ANY web page that
 * anyone on the LAN loads could reach the pre-auth path — scan for the port,
 * fingerprint it, and burn the per-source budget. It could never pass HPKE
 * admission, but it should not get that far.
 *
 * Pure and exported because it CANNOT be exercised end-to-end under the test
 * runner: Bun's `ws` client does not send an `Origin` header at all (measured —
 * `verifyClient` runs, but sees `origin: undefined`), so a browser-shaped
 * connection is unreproducible there. Testing the decision directly is the
 * honest alternative to a test that would pass for the wrong reason.
 */
export function shouldAcceptUpgrade(
	origin: string | undefined,
	admitSource: (source: string) => boolean,
	socket: { remoteAddress?: string | undefined },
): boolean {
	if (origin !== undefined) return false;
	return admitSource(normalizeSourceAddress(socket.remoteAddress ?? ""));
}

/** Await a close callback, but never longer than `ms`. Teardown must not be
 *  able to wedge the caller: a listener that lingers a moment is recoverable, a
 *  `stop()` that never returns blocks vault close and app quit. */
async function closeBounded(close: (done: () => void) => void, ms = 2_000): Promise<void> {
	await new Promise<void>((resolve) => {
		let settled = false;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			resolve();
		};
		const timer = setTimeout(finish, ms);
		if (typeof (timer as { unref?: () => void }).unref === "function") {
			(timer as { unref: () => void }).unref();
		}
		try {
			close(() => {
				clearTimeout(timer);
				finish();
			});
		} catch {
			clearTimeout(timer);
			finish();
		}
	});
}

/** `ws` hands a Buffer (or an array of them for fragmented frames). Normalize
 *  without assuming which, and reject anything else. */
function toBytes(raw: unknown): Uint8Array | null {
	if (raw instanceof Uint8Array) return new Uint8Array(raw);
	if (Array.isArray(raw)) {
		const parts = raw.filter((p): p is Uint8Array => p instanceof Uint8Array);
		if (parts.length === 0) return null;
		const total = parts.reduce((n, p) => n + p.length, 0);
		const out = new Uint8Array(total);
		let at = 0;
		for (const p of parts) {
			out.set(p, at);
			at += p.length;
		}
		return out;
	}
	return null;
}
