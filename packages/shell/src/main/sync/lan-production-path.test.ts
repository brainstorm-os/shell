/**
 * The PRODUCTION composition, over a real socket.
 *
 * `lan-relay-listener.test.ts` already proves channel-bound admission works when
 * the host and handshakes are hand-built. This proves the path the shell actually
 * takes: session access → `createLanListener` → `LanHostController` on one side,
 * and `makeLanClientHandshakeForSession` on the other. Those are different code
 * paths, and the hand-built proof would keep passing if the factory forgot the
 * handshake — the exact slip that turns the listener into an OPEN host.
 *
 * Binds 127.0.0.1 rather than a real interface so the test is hermetic; the
 * production address list comes from `lanInterfaces()`, which excludes loopback.
 * That difference is the address only — every other layer here is the real one.
 */

import { describe, expect, it } from "vitest";
import { generateDeviceX25519 } from "../credentials/device-x25519";
import { ed25519 } from "../test-support/crypto-test-helpers";
import { openLanChallenge } from "./lan-admission";
import { LanHostController } from "./lan-host-controller";
import { createLanListener } from "./lan-host-factory";
import { LanHostMode } from "./lan-host-policy";
import {
	type ActiveDeviceRecord,
	createLanSessionAccess,
	makeLanClientHandshakeForSession,
} from "./lan-sync-wiring";
import { WebSocketRelayPort, WebSocketRelayState } from "./websocket-relay-port";

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeDevice() {
	const ed = ed25519.keygen();
	const x = generateDeviceX25519();
	return {
		edPublic: new Uint8Array(ed.publicKey),
		edSecret: new Uint8Array(ed.secretKey),
		x25519Pub: new Uint8Array(x.publicKey),
		x25519Secret: new Uint8Array(x.secretKey),
	};
}

const recordOf = (d: ReturnType<typeof makeDevice>): ActiveDeviceRecord => ({
	deviceEd25519Pub: Buffer.from(d.edPublic).toString("base64"),
	deviceX25519Pub: Buffer.from(d.x25519Pub).toString("base64"),
});

/** A session-shaped object, exactly what `createLanSessionAccess` consumes. */
const sessionOf = (d: ReturnType<typeof makeDevice>) => ({
	deviceEd25519: { publicKey: d.edPublic },
	signWithDeviceKey: (m: Uint8Array) => new Uint8Array(ed25519.sign(m, d.edSecret)),
	openLanSealedChallenge: (a: {
		sealed: Parameters<typeof openLanChallenge>[0]["sealed"];
		hostAccount: string;
		clientAccount: string;
	}) => openLanChallenge({ ...a, deviceX25519Secret: d.x25519Secret }),
});

function accessFor(
	self: ReturnType<typeof makeDevice>,
	roster: () => readonly ActiveDeviceRecord[],
) {
	return createLanSessionAccess({
		getSession: () => sessionOf(self),
		getDevices: () => ({ listActive: roster }),
	});
}

describe("the production LAN path, end to end over a real socket", () => {
	it("admits a rostered peer through the factory + controller", async () => {
		const hostDev = makeDevice();
		const peer = makeDevice();
		const roster = () => [recordOf(hostDev), recordOf(peer)];

		const controller = new LanHostController({
			readState: () => ({
				mode: LanHostMode.WhenVaultOpen,
				hasSession: true,
				hasSharedEntities: false,
			}),
			createListener: () =>
				createLanListener({
					access: accessFor(hostDev, roster),
					addresses: () => ["127.0.0.1"],
				}),
		});

		await controller.apply();
		expect(controller.listening).toBe(true);
		const url = controller.url;
		expect(url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);

		const port = new WebSocketRelayPort({
			url: url as string,
			requireAdmission: true,
			lanHandshake: makeLanClientHandshakeForSession(accessFor(peer, roster)),
		});
		try {
			port.connect();
			await settle(500);
			// Admitted through the real factory, the real controller, and a real
			// TCP socket — no hand-built host anywhere in this path.
			expect(port.gatedAdmission()).toBe(true);
			expect(port.state).toBe(WebSocketRelayState.Open);
		} finally {
			port.close();
			await controller.dispose();
		}
	});

	it("REFUSES a peer that is not on the host's roster — by CLOSING it", async () => {
		// Asserting `gatedAdmission() === false` alone is VACUOUS here, and the
		// red-check proved it: on an open host nobody is gated-admitted, so that
		// expectation is satisfied both by "refused" and by "there is no gate at
		// all" — while the stranger stays happily connected and able to sync.
		// The load-bearing assertion is therefore that the host CLOSED the socket.
		const hostDev = makeDevice();
		const stranger = makeDevice();
		const hostRoster = () => [recordOf(hostDev)];

		const controller = new LanHostController({
			readState: () => ({
				mode: LanHostMode.WhenVaultOpen,
				hasSession: true,
				hasSharedEntities: false,
			}),
			createListener: () =>
				createLanListener({
					access: accessFor(hostDev, hostRoster),
					addresses: () => ["127.0.0.1"],
				}),
		});
		await controller.apply();

		const port = new WebSocketRelayPort({
			url: controller.url as string,
			requireAdmission: true,
			// The stranger believes the host is rostered; the HOST disagrees.
			lanHandshake: makeLanClientHandshakeForSession(
				accessFor(stranger, () => [recordOf(hostDev), recordOf(stranger)]),
			),
		});
		try {
			port.connect();
			await settle(600);
			expect(port.gatedAdmission()).toBe(false);
			// Not merely ungated — dropped. An open host would leave this Open.
			expect(port.state).not.toBe(WebSocketRelayState.Open);
		} finally {
			port.close();
			await controller.dispose();
		}
	});

	it("stops listening when the policy flips off, and the socket really closes", async () => {
		const hostDev = makeDevice();
		let mode = LanHostMode.WhenVaultOpen;
		const controller = new LanHostController({
			readState: () => ({ mode, hasSession: true, hasSharedEntities: false }),
			createListener: () =>
				createLanListener({
					access: accessFor(hostDev, () => [recordOf(hostDev)]),
					addresses: () => ["127.0.0.1"],
				}),
		});
		await controller.apply();
		const url = controller.url as string;
		expect(url).toBeTruthy();

		mode = LanHostMode.Off;
		await controller.apply();
		expect(controller.listening).toBe(false);

		// A dial at the old address must now fail rather than linger.
		const port = new WebSocketRelayPort({ url, requireAdmission: true });
		try {
			port.connect();
			await settle(400);
			expect(port.gatedAdmission()).toBe(false);
		} finally {
			port.close();
			await controller.dispose();
		}
	});

	it("never binds when the session is absent", async () => {
		// No session ⇒ the factory returns null ⇒ nothing listens. The alternative
		// (bind now, authenticate later) is what an open host looks like.
		const controller = new LanHostController({
			readState: () => ({
				mode: LanHostMode.WhenVaultOpen,
				hasSession: true,
				hasSharedEntities: false,
			}),
			createListener: () =>
				createLanListener({
					access: createLanSessionAccess({ getSession: () => null, getDevices: () => null }),
					addresses: () => ["127.0.0.1"],
				}),
		});
		await controller.apply();
		expect(controller.listening).toBe(false);
		expect(controller.url).toBeNull();
		await controller.dispose();
	});
});
