/**
 * The session→handshake adapter. The freshness test is the important one: a
 * cached roster directory would silently undo the G4 revocation property, and
 * caching is the obvious thing to write.
 */

import { describe, expect, it, vi } from "vitest";
import { generateDeviceX25519 } from "../credentials/device-x25519";
import { ed25519 } from "../test-support/crypto-test-helpers";
import { CHALLENGE_NONCE_BYTES, openLanChallenge } from "./lan-admission";
import {
	type ActiveDeviceRecord,
	type LanSessionAccess,
	activeRosterDirectory,
	deviceAccountId,
	makeLanClientHandshakeForSession,
	makeLanHostHandshakeForSession,
} from "./lan-sync-wiring";

function makeDevice() {
	const ed = ed25519.keygen();
	const x = generateDeviceX25519();
	return {
		account: Buffer.from(new Uint8Array(ed.publicKey)).toString("base64url"),
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

function accessFor(
	self: ReturnType<typeof makeDevice>,
	records: () => readonly ActiveDeviceRecord[],
): LanSessionAccess {
	return {
		deviceEd25519Public: () => self.edPublic,
		signWithDeviceKey: (m) => new Uint8Array(ed25519.sign(m, self.edSecret)),
		activeDeviceRecords: records,
		openSealed: (a) => openLanChallenge({ ...a, deviceX25519Secret: self.x25519Secret }),
	};
}

describe("deviceAccountId", () => {
	it("is the base64url of the Ed25519 public key", () => {
		const d = makeDevice();
		expect(deviceAccountId(d.edPublic)).toBe(d.account);
	});

	it("is null with no session (or an empty key), so callers fail closed", () => {
		expect(deviceAccountId(null)).toBeNull();
		expect(deviceAccountId(new Uint8Array(0))).toBeNull();
	});
});

describe("activeRosterDirectory", () => {
	it("re-reads the records on EVERY access", () => {
		// The G4 property at the LAN layer: a revoke drops the device from
		// `listActive()`, and admission must see that on the next connection —
		// no restart. A cached directory would keep admitting a revoked device.
		const host = makeDevice();
		const peer = makeDevice();
		let records: ActiveDeviceRecord[] = [recordOf(host), recordOf(peer)];
		const access = { activeDeviceRecords: () => records };

		expect(activeRosterDirectory(access).has(peer.account)).toBe(true);
		records = [recordOf(host)]; // peer revoked
		expect(activeRosterDirectory(access).has(peer.account)).toBe(false);
	});

	it("is consulted lazily by the handshake, not captured at construction", () => {
		const host = makeDevice();
		const peer = makeDevice();
		const records = vi.fn(() => [recordOf(host), recordOf(peer)]);
		const handshake = makeLanHostHandshakeForSession(accessFor(host, records));
		expect(records).not.toHaveBeenCalled(); // nothing read up front

		handshake.sealFor(peer.account, new Uint8Array(CHALLENGE_NONCE_BYTES).fill(1));
		const afterFirst = records.mock.calls.length;
		expect(afterFirst).toBeGreaterThan(0);

		handshake.sealFor(peer.account, new Uint8Array(CHALLENGE_NONCE_BYTES).fill(2));
		expect(records.mock.calls.length).toBeGreaterThan(afterFirst); // re-read
	});
});

describe("session-backed handshakes", () => {
	it("complete a full channel-bound admission between two rostered devices", () => {
		const host = makeDevice();
		const client = makeDevice();
		const roster = () => [recordOf(host), recordOf(client)];

		const hostSide = makeLanHostHandshakeForSession(accessFor(host, roster));
		const clientSide = makeLanClientHandshakeForSession(accessFor(client, roster));

		const nonce = new Uint8Array(CHALLENGE_NONCE_BYTES).fill(5);
		const sealed = hostSide.sealFor(client.account, nonce);
		expect(sealed).not.toBeNull();

		const auth = clientSide.onSealedChallenge(host.account, sealed as never);
		expect(auth).not.toBeNull();
		expect(hostSide.verifyClient(client.account, (auth as { sig: string }).sig, nonce)).toBe(true);

		const proof = hostSide.proveToClient(client.account, nonce);
		expect(proof).not.toBeNull();
		expect(clientSide.verifyHostProof(proof as string)).toBe(true);
	});

	it("refuses a device that has just been revoked", () => {
		// Same handshake instance, roster changed underneath — exactly what a
		// revoke looks like while a peer is trying to reconnect.
		const host = makeDevice();
		const client = makeDevice();
		let roster: ActiveDeviceRecord[] = [recordOf(host), recordOf(client)];
		const hostSide = makeLanHostHandshakeForSession(accessFor(host, () => roster));

		const nonce = new Uint8Array(CHALLENGE_NONCE_BYTES).fill(3);
		expect(hostSide.sealFor(client.account, nonce)).not.toBeNull();

		roster = [recordOf(host)];
		expect(hostSide.sealFor(client.account, nonce)).toBeNull();
	});

	it("refuses everything when there is no session", () => {
		// Locked vault / boot / between vaults: every getter returns null and the
		// handshakes must decline rather than throw.
		const nullAccess: LanSessionAccess = {
			deviceEd25519Public: () => null,
			signWithDeviceKey: () => null,
			activeDeviceRecords: () => [],
			openSealed: () => null,
		};
		const hostSide = makeLanHostHandshakeForSession(nullAccess);
		const clientSide = makeLanClientHandshakeForSession(nullAccess);
		const nonce = new Uint8Array(CHALLENGE_NONCE_BYTES).fill(1);

		expect(hostSide.sealFor("whoever", nonce)).toBeNull();
		expect(hostSide.proveToClient("whoever", nonce)).toBeNull();
		expect(hostSide.verifyClient("whoever", "sig", nonce)).toBe(false);
		expect(clientSide.helloAccount()).toBeNull();
		expect(clientSide.verifyHostProof("proof")).toBe(false);
	});

	it("refuses a peer that is not on the roster at all", () => {
		const host = makeDevice();
		const stranger = makeDevice();
		const hostSide = makeLanHostHandshakeForSession(accessFor(host, () => [recordOf(host)]));
		expect(
			hostSide.sealFor(stranger.account, new Uint8Array(CHALLENGE_NONCE_BYTES).fill(4)),
		).toBeNull();
	});
});
