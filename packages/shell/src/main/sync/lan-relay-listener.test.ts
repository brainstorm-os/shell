/**
 * LAN-4b — the real inbound socket.
 *
 * These are the only LAN tests that bind an actual port, so they are where the
 * properties that cannot exist in-process get checked: wildcard refusal,
 * interface selection, per-source rate limiting, and that a real peer goes
 * through the SAME admission state machine as the localhost proof.
 *
 * Everything binds to 127.0.0.1 — the tests must not put a listener on a real
 * network interface on a developer's machine or in CI.
 */

import { describe, expect, it } from "vitest";
import { generateDeviceX25519 } from "../credentials/device-x25519";
import { bytesToBase64Url } from "../pairing/pairing-channel";
import { ed25519 } from "../test-support/crypto-test-helpers";
import { type LanRosterEntry, makeLanClientHandshake, makeLanHostHandshake } from "./lan-admission";
import { LanRelayHost } from "./lan-relay-host";
import {
	DEFAULT_LAN_MAX_SOCKETS,
	LanRelayListener,
	RESERVED_FOR_FRESH_SOURCES,
	isBindableAddress,
	lanInterfaces,
	normalizeSourceAddress,
	shouldAcceptUpgrade,
} from "./lan-relay-listener";
import { WebSocketRelayPort } from "./websocket-relay-port";

const testVerify = (pub: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean =>
	ed25519.verify(sig, msg, pub);

function makeDevice() {
	const ed = ed25519.keygen();
	const x = generateDeviceX25519();
	return {
		account: bytesToBase64Url(new Uint8Array(ed.publicKey)),
		edSecret: new Uint8Array(ed.secretKey),
		edPublic: new Uint8Array(ed.publicKey),
		x25519Pub: new Uint8Array(x.publicKey),
		x25519Secret: new Uint8Array(x.secretKey),
	};
}

function directoryOf(...devices: ReturnType<typeof makeDevice>[]): Map<string, LanRosterEntry> {
	return new Map(
		devices.map((d) => [d.account, { ed25519Pub: d.edPublic, x25519Pub: d.x25519Pub }]),
	);
}

async function settle(tries = 80): Promise<void> {
	for (let i = 0; i < tries; i++) await new Promise((r) => setTimeout(r, 1));
}

describe("LanRelayListener — the first inbound socket (LAN-4b)", () => {
	it("REFUSES a wildcard bind (T1: that is the internet, not a LAN)", () => {
		const host = new LanRelayHost();
		expect(() => new LanRelayListener({ host, address: "0.0.0.0" })).toThrow(/wildcard/i);
		expect(() => new LanRelayListener({ host, address: "::" })).toThrow(/wildcard/i);
		expect(() => new LanRelayListener({ host, address: "" })).toThrow(/wildcard/i);
		host.close();
	});

	it("the bind guard is an ALLOWLIST — every wildcard spelling is refused", () => {
		// The first version compared against the literal strings "0.0.0.0" and
		// "::". The pentest bypassed it with `"0"`, `"::0"`, `"0x0"` and
		// `"0.0.0.0."`, each of which bound the WILDCARD and was reachable
		// off-loopback on the machine's real LAN address. A blocklist also can't
		// express "not public": a hostname or routable literal passed.
		for (const bad of [
			"0.0.0.0",
			"::",
			"",
			"0",
			"::0",
			"0:0:0:0:0:0:0:0",
			"0x0",
			"0.0.0.0.",
			"localhost", // a NAME — never let the resolver decide
			"example.com",
			"8.8.8.8", // routable literal
			"172.32.0.1", // just outside the private range
			"999.1.1.1",
		]) {
			expect(isBindableAddress(bad)).toBe(false);
		}
		// …and the legitimate forms still work.
		for (const good of ["127.0.0.1", "192.168.1.20", "10.0.0.5", "172.16.4.9", "169.254.10.1"]) {
			expect(isBindableAddress(good)).toBe(true);
		}
		const host = new LanRelayHost();
		expect(() => new LanRelayListener({ host, address: "0" })).toThrow(/private or loopback/i);
		host.close();
	});

	it("a REFUSED socket cannot take down the process (malformed frame, no unhandled 'error')", async () => {
		// The pentest's actual repro: exceed the per-source budget so a socket is
		// REFUSED, then send it one malformed frame (RSV1 set). Both refusal
		// paths used to hand back a live `ws` socket with no 'error' listener,
		// and an unhandled emitter 'error' throws — an unpaired LAN host reached
		// an uncaught exception in the shell main process this way.
		//
		// A normal `ws` client will never send a malformed frame, so this drives
		// the handshake by hand over a raw socket.
		//
		// ⚠️ HONEST LIMIT: this test passes with the fix REVERTED too. Bun does
		// not route the malformed frame into `ws`'s validator the way Node does
		// (same class as the `connection`-event gap noted in the source), so the
		// throw cannot be reproduced under this runner. The vulnerability was
		// demonstrated under NODE — the runtime Electron uses — where 11
		// connections plus one RSV1 frame reached an uncaught exception. The test
		// is kept as a live smoke check of the invariant, NOT as proof of the
		// fix; the fix's correctness rests on attaching the handler before any
		// early return, which is unconditional.
		const net = await import("node:net");
		const host = new LanRelayHost();
		const listener = new LanRelayListener({
			host,
			address: "127.0.0.1",
			maxConnectionsPerSource: 1,
		});
		const bound = await listener.start();
		let sawUnhandled: unknown = null;
		const onUnhandled = (err: unknown): void => {
			sawUnhandled = err;
		};
		process.on("uncaughtException", onUnhandled);
		const raws: import("node:net").Socket[] = [];
		try {
			// Two handshakes from one source: the second is past the budget.
			for (let i = 0; i < 2; i++) {
				const sock = net.connect(bound.port, "127.0.0.1");
				sock.on("error", () => {});
				raws.push(sock);
				await new Promise<void>((resolve) => {
					sock.once("connect", () => resolve());
					sock.once("error", () => resolve());
				});
				sock.write(
					`GET / HTTP/1.1\r\nHost: 127.0.0.1:${bound.port}\r\nUpgrade: websocket\r\n` +
						"Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
						"Sec-WebSocket-Version: 13\r\n\r\n",
				);
				await settle(120);
			}
			// One masked frame with RSV1 set on the refused (second) socket.
			const refused = raws[raws.length - 1] as import("node:net").Socket;
			refused.write(Buffer.from([0xc1, 0x82, 0x00, 0x00, 0x00, 0x00, 0x61, 0x62]));
			await settle(300);
			expect(sawUnhandled).toBeNull();
		} finally {
			process.off("uncaughtException", onUnhandled);
			for (const r of raws) r.destroy();
			await listener.stop();
			host.close();
		}
	});

	it("a bind failure REJECTS instead of throwing unhandled", async () => {
		// `ws` re-emits the http server's 'error' on the WebSocketServer, which
		// had no listener — so EADDRNOTAVAIL / EADDRINUSE escaped as an uncaught
		// exception. That is the ordinary laptop case: Wi-Fi flaps between
		// enumerating interfaces and binding.
		const host = new LanRelayHost();
		const first = new LanRelayListener({ host, address: "127.0.0.1" });
		const bound = await first.start();
		const clash = new LanRelayListener({ host, address: "127.0.0.1", port: bound.port });
		let sawUnhandled = false;
		const onUnhandled = (): void => {
			sawUnhandled = true;
		};
		process.on("uncaughtException", onUnhandled);
		try {
			await expect(clash.start()).rejects.toThrow();
			expect(sawUnhandled).toBe(false);
		} finally {
			process.off("uncaughtException", onUnhandled);
			await clash.stop();
			await first.stop();
			host.close();
		}
	});

	it("only ever offers private / link-local interfaces to bind to", () => {
		// The helper is what stops a caller reaching for a routable address; it
		// must never return one, whatever this machine happens to have.
		for (const iface of lanInterfaces()) {
			const [a, b] = iface.address.split(".").map(Number) as [number, number];
			const priv =
				a === 10 ||
				(a === 192 && b === 168) ||
				(a === 172 && b >= 16 && b <= 31) ||
				(a === 169 && b === 254);
			expect(priv).toBe(true);
		}
	});

	it("binds, reports a dialable url, and stops idempotently", async () => {
		const host = new LanRelayHost();
		const listener = new LanRelayListener({ host, address: "127.0.0.1" });
		try {
			const bound = await listener.start();
			expect(bound.port).toBeGreaterThan(0);
			expect(bound.url).toBe(`ws://127.0.0.1:${bound.port}`);
			// Idempotent: a second start returns the same address, not a new port.
			expect((await listener.start()).port).toBe(bound.port);
			expect(listener.address()).not.toBeNull();
		} finally {
			await listener.stop();
			await listener.stop(); // idempotent
			expect(listener.address()).toBeNull();
			host.close();
		}
	});

	it("a REAL socket runs the same channel-bound admission as the in-process proof", async () => {
		const hostDev = makeDevice();
		const client = makeDevice();
		const dir = directoryOf(hostDev, client);
		const relayHost = new LanRelayHost({
			hostAccount: hostDev.account,
			handshake: makeLanHostHandshake({
				hostAccount: () => hostDev.account,
				activeDevices: () => dir,
				signWithDeviceKey: (m) => new Uint8Array(ed25519.sign(m, hostDev.edSecret)),
				verify: testVerify,
			}),
		});
		const listener = new LanRelayListener({ host: relayHost, address: "127.0.0.1" });
		const bound = await listener.start();
		const port = new WebSocketRelayPort({
			url: bound.url,
			requireAdmission: true,
			lanHandshake: makeLanClientHandshake({
				deviceAccount: () => client.account,
				deviceX25519Secret: () => client.x25519Secret,
				signWithDeviceKey: (m) => new Uint8Array(ed25519.sign(m, client.edSecret)),
				activeDevices: () => dir,
				verify: testVerify,
			}),
		});
		try {
			port.connect();
			await settle(400);
			// Admitted over a genuine TCP socket — no in-process shortcut.
			expect(port.gatedAdmission()).toBe(true);
		} finally {
			port.close();
			await listener.stop();
			relayHost.close();
		}
	});

	it("a device NOT in the roster is refused over a real socket too", async () => {
		const hostDev = makeDevice();
		const client = makeDevice();
		const stranger = makeDevice();
		const dir = directoryOf(hostDev, client); // stranger absent
		const relayHost = new LanRelayHost({
			hostAccount: hostDev.account,
			handshake: makeLanHostHandshake({
				hostAccount: () => hostDev.account,
				activeDevices: () => dir,
				signWithDeviceKey: (m) => new Uint8Array(ed25519.sign(m, hostDev.edSecret)),
				verify: testVerify,
			}),
		});
		const listener = new LanRelayListener({ host: relayHost, address: "127.0.0.1" });
		const bound = await listener.start();
		const port = new WebSocketRelayPort({
			url: bound.url,
			requireAdmission: true,
			lanHandshake: makeLanClientHandshake({
				deviceAccount: () => stranger.account,
				deviceX25519Secret: () => stranger.x25519Secret,
				signWithDeviceKey: (m) => new Uint8Array(ed25519.sign(m, stranger.edSecret)),
				activeDevices: () => directoryOf(hostDev, stranger),
				verify: testVerify,
			}),
		});
		try {
			port.connect();
			await settle(400);
			expect(port.gatedAdmission()).toBe(false);
		} finally {
			port.close();
			await listener.stop();
			relayHost.close();
		}
	});

	it("ANSWERS a plain HTTP request instead of hanging forever", async () => {
		// Found by probing this listener: with no request handler a plain GET
		// hung with no response and no timeout, and the rate limiter never saw
		// it (that only fires on a WebSocket `connection`) — so any LAN host
		// could hold un-upgraded sockets against us having proven nothing.
		//
		// The companion defense — reaping sockets that connect and send NOTHING
		// — is deliberately not asserted here: Bun's `node:http` never emits
		// `connection`, so it cannot work under this runner. It is verified
		// under Node (the runtime Electron uses); see the note in the source.
		const host = new LanRelayHost();
		const listener = new LanRelayListener({ host, address: "127.0.0.1" });
		try {
			const bound = await listener.start();
			const res = await fetch(`http://127.0.0.1:${bound.port}/`, {
				signal: AbortSignal.timeout(3_000),
			});
			expect(res.status).toBe(426); // Upgrade Required
		} finally {
			await listener.stop();
			host.close();
		}
	});

	it("normalizes IPv4-mapped IPv6 so one peer cannot claim two budgets", () => {
		// `::ffff:10.0.0.5` and `10.0.0.5` are the same host. Keying the rate
		// limiter on the raw string would give it double the allowance, which is
		// the entire correctness of the limit.
		expect(normalizeSourceAddress("::ffff:10.0.0.5")).toBe("10.0.0.5");
		expect(normalizeSourceAddress("::FFFF:10.0.0.5")).toBe("10.0.0.5");
		expect(normalizeSourceAddress("10.0.0.5")).toBe("10.0.0.5");
		expect(normalizeSourceAddress("::ffff:10.0.0.5")).toBe(normalizeSourceAddress("10.0.0.5"));
		// A genuine IPv6 peer is left alone.
		expect(normalizeSourceAddress("fe80::1")).toBe("fe80::1");
	});

	it("RATE-LIMITS one source address (the G9 half that needs a real socket)", async () => {
		const relayHost = new LanRelayHost();
		let clock = 1_000;
		const listener = new LanRelayListener({
			host: relayHost,
			address: "127.0.0.1",
			maxConnectionsPerSource: 3,
			rateWindowMs: 10_000,
			now: () => clock,
		});
		const bound = await listener.start();
		const ports: WebSocketRelayPort[] = [];
		try {
			for (let i = 0; i < 6; i++) {
				const p = new WebSocketRelayPort({ url: bound.url });
				p.connect();
				ports.push(p);
			}
			await settle(400);
			// Only the first 3 from this source survive the window.
			expect(relayHost.connectionCount()).toBeLessThanOrEqual(3);

			// …and the window rolls: past it, the same source is allowed again.
			clock += 20_000;
			const later = new WebSocketRelayPort({ url: bound.url });
			later.connect();
			ports.push(later);
			await settle(400);
			expect(relayHost.connectionCount()).toBeGreaterThan(0);
		} finally {
			for (const p of ports) p.close();
			await listener.stop();
			relayHost.close();
		}
	});
});

describe("LanRelayListener — GA hardening from the post-bind pentest", () => {
	it("L6 — concurrent start() opens ONE port, and stop() leaves none listening", async () => {
		// Two un-awaited calls in one tick used to open TWO ports; the second won
		// `#bound` and the first was orphaned — still listening, still adopting
		// peers, unreachable to close.
		const net = await import("node:net");
		const host = new LanRelayHost();
		const listener = new LanRelayListener({ host, address: "127.0.0.1" });
		try {
			const [a, b] = await Promise.all([listener.start(), listener.start()]);
			expect(a.port).toBe(b.port);
			const port = a.port;
			await listener.stop();
			expect(listener.address()).toBeNull();
			// Nothing may still accept on that port.
			const reachable = await new Promise<boolean>((resolve) => {
				const probe = net.connect(port, "127.0.0.1");
				probe.on("connect", () => {
					probe.destroy();
					resolve(true);
				});
				probe.on("error", () => resolve(false));
			});
			expect(reachable).toBe(false);
		} finally {
			host.close();
		}
	});

	it("L8 — an upgrade carrying Origin is refused before the handshake", () => {
		// Tested as the pure decision, NOT end-to-end: Bun's ws client does not
		// send an Origin header at all (measured — verifyClient runs but sees
		// `undefined`), so a browser-shaped connection cannot be reproduced under
		// this runner. An e2e test here would pass for the wrong reason.
		const admitAll = () => true;
		const sock = { remoteAddress: "127.0.0.1" };
		// A browser — any origin at all — is refused.
		for (const origin of ["https://evil.example", "null", "file://", ""]) {
			expect(shouldAcceptUpgrade(origin, admitAll, sock)).toBe(false);
		}
		// A native peer sends no Origin and is accepted…
		expect(shouldAcceptUpgrade(undefined, admitAll, sock)).toBe(true);
		// …still subject to the per-source decision.
		expect(shouldAcceptUpgrade(undefined, () => false, sock)).toBe(false);
	});

	it("L10 — the 426 body is empty (no product fingerprint)", async () => {
		const host = new LanRelayHost();
		const listener = new LanRelayListener({ host, address: "127.0.0.1" });
		try {
			const bound = await listener.start();
			const res = await fetch(`http://127.0.0.1:${bound.port}/`, {
				signal: AbortSignal.timeout(3_000),
			});
			expect(res.status).toBe(426);
			const body = await res.text();
			expect(body).toBe("");
			expect(body.toLowerCase()).not.toContain("brainstorm");
		} finally {
			await listener.stop();
			host.close();
		}
	});

	it("L4 — a source holding sockets cannot exceed its cap once the rate window rolls", async () => {
		// This is what accept-layer LIVE accounting adds over the old rate window,
		// and the distinguishing case matters: the rate limiter only counts
		// connections PER WINDOW, so a peer could hold N sockets open forever and,
		// the moment the window expired, open N more — repeatedly. Live counting
		// binds on concurrency instead, which is what actually starves the accept
		// queue.
		//
		// (A naive "≤3 connections" assertion here passes with the live cap
		// REVERTED, because the rate window caps at the same number. It did.)
		const { WebSocket } = await import("ws");
		const host = new LanRelayHost();
		let clock = 1_000;
		const listener = new LanRelayListener({
			host,
			address: "127.0.0.1",
			maxConnectionsPerSource: 2,
			rateWindowMs: 5_000,
			now: () => clock,
		});
		const bound = await listener.start();
		const sockets: import("ws").WebSocket[] = [];
		const open = (): void => {
			const ws = new WebSocket(bound.url);
			ws.on("error", () => {});
			sockets.push(ws);
		};
		try {
			open();
			open();
			await settle(400);
			const held = host.connectionCount();
			expect(held).toBeLessThanOrEqual(2);

			// Roll the rate window WITHOUT closing anything. The old limiter would
			// hand out a fresh budget here; live accounting must not, because the
			// source is still holding its slots.
			clock += 60_000;
			open();
			open();
			open();
			await settle(400);
			expect(host.connectionCount()).toBeLessThanOrEqual(2);
		} finally {
			for (const ws of sockets) {
				try {
					ws.terminate();
				} catch {
					// already gone
				}
			}
			await listener.stop();
			host.close();
		}
	});

	it("L4 — the reserve keeps slots for sources we are not already talking to", () => {
		// `http.maxConnections` is global and cannot tell peers apart, so alone it
		// let one host deny the whole feature (measured: a fresh peer got
		// ECONNRESET while an attacker held the ceiling).
		expect(RESERVED_FOR_FRESH_SOURCES).toBeGreaterThan(0);
		expect(DEFAULT_LAN_MAX_SOCKETS).toBeGreaterThan(RESERVED_FOR_FRESH_SOURCES * 2);
	});
});
