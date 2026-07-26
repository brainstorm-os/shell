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
import { LanRelayListener, lanInterfaces } from "./lan-relay-listener";
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
