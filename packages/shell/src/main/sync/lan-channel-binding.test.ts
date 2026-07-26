/**
 * LAN-2b(a) — channel-bound admission (gate finding G2).
 *
 * The property under test is the one a signature CANNOT give you: that the key
 * proving membership is on the other end of *this* connection. The design's
 * prescribed "mutual challenge" fails against a relay — the attacker forwards
 * each side's nonce to the other and both sides finish "authenticated" with it
 * in the middle. Binding the challenge to an X25519 key agreement fixes that,
 * and test 1 is the relay the old design had no answer for.
 *
 * Test plan: docs/data/lan-channel-binding.md §Test plan.
 */

import { describe, expect, it } from "vitest";
import { generateDeviceX25519 } from "../credentials/device-x25519";
import { ed25519 } from "../test-support/crypto-test-helpers";
import {
	CHALLENGE_NONCE_BYTES,
	LanProofDirection,
	lanProofBytes,
	openLanChallenge,
	sealLanChallenge,
} from "./lan-admission";

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

/** A paired device: an Ed25519 identity (the LAN principal) + the X25519
 *  keypair its roster record carries. */
function makeDevice() {
	const ed = ed25519.keygen();
	const x = generateDeviceX25519();
	return {
		account: b64url(new Uint8Array(ed.publicKey)),
		edSecret: new Uint8Array(ed.secretKey),
		edPublic: new Uint8Array(ed.publicKey),
		x25519Pub: new Uint8Array(x.publicKey),
		x25519Secret: new Uint8Array(x.secretKey),
	};
}

const NONCE = new Uint8Array(CHALLENGE_NONCE_BYTES).map((_, i) => (i * 7) % 251);

describe("channel-bound LAN admission (G2)", () => {
	it("happy path — the addressed device opens the challenge and proves itself", () => {
		const host = makeDevice();
		const client = makeDevice();

		const sealed = sealLanChallenge({
			clientX25519Pub: client.x25519Pub,
			hostAccount: host.account,
			clientAccount: client.account,
			nonce: NONCE,
		});
		const opened = openLanChallenge({
			sealed,
			deviceX25519Secret: client.x25519Secret,
			hostAccount: host.account,
			clientAccount: client.account,
		});
		expect(opened).not.toBeNull();
		expect([...(opened as Uint8Array)]).toEqual([...NONCE]);

		// …and the proof over the opened nonce verifies for the host.
		const msg = lanProofBytes(
			LanProofDirection.Client,
			host.account,
			client.account,
			opened as Uint8Array,
		);
		const sig = ed25519.sign(msg, client.edSecret);
		expect(ed25519.verify(sig, msg, client.edPublic)).toBe(true);
	});

	it("RELAY ATTACK — a man in the middle cannot complete the handshake", () => {
		// Three parties. The attacker is on the LAN, is NOT paired, and holds no
		// device secret; it can only forward bytes between the honest client and
		// the honest host (rogue advert / ARP-spoofed ws://).
		const realHost = makeDevice();
		const victim = makeDevice();
		const attacker = makeDevice(); // its own keys — not in the vault roster

		// The attacker opens a connection to the real host, claiming to be
		// itself (it must: it can only prove keys it holds).
		const forHostSideOfAttacker = sealLanChallenge({
			clientX25519Pub: attacker.x25519Pub,
			hostAccount: realHost.account,
			clientAccount: attacker.account,
			nonce: NONCE,
		});

		// It now tries to make the VICTIM answer that challenge for it — the
		// forwarding move that defeats a signature-only mutual challenge.
		// (a) Forward the ciphertext verbatim: sealed to the ATTACKER's X25519
		//     key, so the victim cannot open it.
		expect(
			openLanChallenge({
				sealed: forHostSideOfAttacker,
				deviceX25519Secret: victim.x25519Secret,
				hostAccount: realHost.account,
				clientAccount: attacker.account,
			}),
		).toBeNull();

		// (b) Re-seal to the victim instead — the attacker CAN do this (public
		//     keys are public), but it must then name the victim as the client,
		//     and it does not know the nonce it is supposed to be relaying,
		//     because it could never open the real host's ciphertext. Sealing a
		//     nonce IT chose yields a proof bound to a nonce the real host never
		//     issued, so the host rejects it.
		const attackerChosenNonce = new Uint8Array(CHALLENGE_NONCE_BYTES).fill(9);
		const reSealed = sealLanChallenge({
			clientX25519Pub: victim.x25519Pub,
			hostAccount: realHost.account,
			clientAccount: victim.account,
			nonce: attackerChosenNonce,
		});
		const victimOpened = openLanChallenge({
			sealed: reSealed,
			deviceX25519Secret: victim.x25519Secret,
			hostAccount: realHost.account,
			clientAccount: victim.account,
		});
		expect(victimOpened).not.toBeNull(); // the victim answers, unaware

		// The proof the attacker harvests is over the attacker's nonce and the
		// victim's account. On its OWN connection the host expects a proof over
		// the host's real nonce and the ATTACKER's account. Neither matches.
		const harvested = lanProofBytes(
			LanProofDirection.Client,
			realHost.account,
			victim.account,
			victimOpened as Uint8Array,
		);
		const harvestedSig = ed25519.sign(harvested, victim.edSecret);

		const whatHostWillCheck = lanProofBytes(
			LanProofDirection.Client,
			realHost.account,
			attacker.account, // the account the attacker authenticated as
			NONCE, // the nonce the real host actually issued
		);
		expect(ed25519.verify(harvestedSig, whatHostWillCheck, victim.edPublic)).toBe(false);
		// …and it is not the attacker's key either, so claiming the victim's
		// account gets it nowhere: it cannot sign for a key it doesn't hold.
		expect(ed25519.verify(harvestedSig, whatHostWillCheck, attacker.edPublic)).toBe(false);
	});

	it("wrong X25519 secret cannot open the challenge", () => {
		const host = makeDevice();
		const client = makeDevice();
		const other = makeDevice();
		const sealed = sealLanChallenge({
			clientX25519Pub: client.x25519Pub,
			hostAccount: host.account,
			clientAccount: client.account,
			nonce: NONCE,
		});
		expect(
			openLanChallenge({
				sealed,
				deviceX25519Secret: other.x25519Secret,
				hostAccount: host.account,
				clientAccount: client.account,
			}),
		).toBeNull();
	});

	it("a challenge sealed for one connection does not open on another (AAD binds both accounts)", () => {
		const host = makeDevice();
		const client = makeDevice();
		const sealed = sealLanChallenge({
			clientX25519Pub: client.x25519Pub,
			hostAccount: host.account,
			clientAccount: client.account,
			nonce: NONCE,
		});
		// Right recipient key, wrong account pair ⇒ AEAD tag mismatch.
		expect(
			openLanChallenge({
				sealed,
				deviceX25519Secret: client.x25519Secret,
				hostAccount: makeDevice().account,
				clientAccount: client.account,
			}),
		).toBeNull();
		expect(
			openLanChallenge({
				sealed,
				deviceX25519Secret: client.x25519Secret,
				hostAccount: host.account,
				clientAccount: makeDevice().account,
			}),
		).toBeNull();
	});

	it("a tampered ciphertext does not open", () => {
		const host = makeDevice();
		const client = makeDevice();
		const sealed = sealLanChallenge({
			clientX25519Pub: client.x25519Pub,
			hostAccount: host.account,
			clientAccount: client.account,
			nonce: NONCE,
		});
		const ct = Buffer.from(sealed.ct, "base64url");
		ct[0] = (ct[0] ?? 0) ^ 0xff;
		expect(
			openLanChallenge({
				sealed: { enc: sealed.enc, ct: ct.toString("base64url") },
				deviceX25519Secret: client.x25519Secret,
				hostAccount: host.account,
				clientAccount: client.account,
			}),
		).toBeNull();
	});

	it("REFLECTION — a client proof does not verify as a host proof", () => {
		// Without direction tags a rogue host could bounce the client's own
		// proof back and "prove" itself with it.
		const host = makeDevice();
		const client = makeDevice();
		const clientMsg = lanProofBytes(LanProofDirection.Client, host.account, client.account, NONCE);
		const hostMsg = lanProofBytes(LanProofDirection.Host, host.account, client.account, NONCE);
		expect([...clientMsg]).not.toEqual([...hostMsg]);

		const clientSig = ed25519.sign(clientMsg, client.edSecret);
		// The reflected proof fails as a host proof, under either key.
		expect(ed25519.verify(clientSig, hostMsg, client.edPublic)).toBe(false);
		expect(ed25519.verify(clientSig, hostMsg, host.edPublic)).toBe(false);
	});
});
