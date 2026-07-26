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

import { type Server, createServer } from "node:http";
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
	now?: () => number;
};

/** A bound listener. `url` is exactly what goes in the pairing payload's
 *  `relayUrl` slot (LAN-3). */
export type LanListenerAddress = { address: string; port: number; url: string };

export class LanRelayListener {
	readonly #opts: Required<Omit<LanRelayListenerOptions, "host" | "port">> &
		Pick<LanRelayListenerOptions, "host" | "port">;
	#http: Server | null = null;
	#wss: WebSocketServer | null = null;
	#bound: LanListenerAddress | null = null;
	/** source address → recent connection timestamps (rate limiting). */
	readonly #recent = new Map<string, number[]>();

	constructor(opts: LanRelayListenerOptions) {
		if (!opts.address || opts.address === "0.0.0.0" || opts.address === "::") {
			// Refuse the wildcard outright rather than trusting every caller to
			// remember: this is the difference between "my LAN" and "the internet".
			throw new Error("LanRelayListener: address must be a specific interface, not a wildcard");
		}
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
		// A plain HTTP request must get a definite answer and be closed. Found by
		// probing this listener: with no request handler the connection HUNG
		// FOREVER — no response, no timeout — and the rate limiter never saw it,
		// because that only fires on a WebSocket `connection`. So any LAN host
		// could hold unlimited un-upgraded sockets against us with no roster
		// membership and no crypto: pre-auth exhaustion (T1/T7) through the one
		// door the admission machinery doesn't cover.
		const http = createServer((_req, res) => {
			res.writeHead(426, { "content-type": "text/plain" }); // Upgrade Required
			res.end("brainstorm-lan: websocket only\n");
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
			// No compression: permessage-deflate on attacker-influenced data is a
			// memory-amplification surface, and our frames are already sealed
			// (ciphertext does not compress).
			perMessageDeflate: false,
		});
		wss.on("connection", (socket, request) => {
			const source = request.socket.remoteAddress ?? "";
			if (!this.#allowSource(source)) {
				socket.close();
				return;
			}
			this.#adopt(socket);
		});
		this.#http = http;
		this.#wss = wss;

		await new Promise<void>((resolve, reject) => {
			const onError = (err: Error): void => {
				http.off("listening", onListening);
				reject(err);
			};
			const onListening = (): void => {
				http.off("error", onError);
				resolve();
			};
			http.once("error", onError);
			http.once("listening", onListening);
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
		const wss = this.#wss;
		const http = this.#http;
		this.#wss = null;
		this.#http = null;
		this.#bound = null;
		this.#recent.clear();
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
	}

	/** G9 (per-source half) — bound how fast one address may reconnect. The
	 *  in-process host caps TOTAL connections; without this a single hostile
	 *  peer can churn through that budget and lock legitimate devices out. */
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
	}): void {
		const host = this.#opts.host;
		const serverWs = {
			send: (data: Uint8Array | string): void => {
				if (typeof data === "string") return;
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
