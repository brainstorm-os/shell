/**
 * SECURITY REGRESSION — the challenge signature must not be a signing oracle
 * for the sovereign user key.
 *
 * The gated-admission handshake (SYNC-4b, and its LAN inversion in LAN-2) has
 * the client sign the *server's* nonce with `VaultSession.signPayload` — the
 * SOVEREIGN USER Ed25519 key, the same key that signs `add-device` roster
 * records (`signAddDeviceRecord` over `canonicalAddDeviceBytes`, plain
 * unprefixed JSON). Neither message carries a domain-separation tag, so the
 * two signature domains OVERLAP: a node that chooses the nonce chooses the
 * bytes the user key signs.
 *
 * On the cloud path the relay is already declared untrusted; on the LAN path
 * ANY peer can be the host (rogue mDNS advert / stale pairing address / MITM
 * on plaintext ws://). Either way the attacker sets
 * `nonce = base64url(canonicalAddDeviceBytes(<attacker's device>))`, and the
 * signature that comes back is a valid roster record adding the attacker's
 * device to the victim's vault.
 *
 * The first test DEMONSTRATES the attack against the raw primitives (it is the
 * repro, and it must keep passing — it describes the math, which doesn't
 * change). The rest pin the FIX: the responders prefix the signed bytes with a
 * challenge-domain tag, so a signature they produce can never be replayed as a
 * roster record.
 */

import { ed25519Verify } from "@brainstorm-os/native";
import { describe, expect, it } from "vitest";
import { generateIdentity, signPayload } from "../credentials/identity";
import { canonicalAddDeviceBytes, verifyAddDeviceRecord } from "../pairing/devices-store";
import { makeChallengeResponder } from "./challenge-responder";
import { CHALLENGE_DOMAIN_TAG, makeLanChallengeResponder } from "./lan-admission";

function b64url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

function b64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}

/** The record a LAN/relay attacker wants signed: its own device, in the
 *  victim's roster, attributed to the victim's sovereign user key. */
function attackerRecordInput(userPub: Uint8Array, attacker: { ed: Uint8Array; x: Uint8Array }) {
	return {
		deviceEd25519Pub: b64(attacker.ed),
		deviceX25519Pub: b64(attacker.x),
		deviceLabel: "Attacker's laptop",
		addedAt: 1_770_000_000_000,
		addedBy: b64(userPub),
	};
}

describe("challenge signature / roster domain overlap", () => {
	it("REPRO: an unprefixed nonce signature IS a valid add-device record", () => {
		const user = generateIdentity();
		const attackerEd = generateIdentity();
		const attackerX = generateIdentity();
		const input = attackerRecordInput(user.publicKey, {
			ed: attackerEd.publicKey,
			x: attackerX.publicKey,
		});

		// The attacker (acting as the LAN host / a malicious relay) issues the
		// canonical roster bytes AS the challenge nonce.
		const nonceBytes = canonicalAddDeviceBytes(input);

		// A responder with no domain separation signs exactly those bytes.
		const rawSignature = signPayload(user.secretKey, nonceBytes);

		// ⇒ the reply is a valid roster record. This is the vulnerability.
		const forged = { ...input, sig: b64(rawSignature) };
		expect(verifyAddDeviceRecord(forged, user.publicKey)).toBe(true);
	});

	it("the LAN responder REFUSES to sign roster-shaped bytes", async () => {
		const user = generateIdentity();
		const device = generateIdentity();
		const attackerEd = generateIdentity();
		const attackerX = generateIdentity();
		const input = attackerRecordInput(user.publicKey, {
			ed: attackerEd.publicKey,
			x: attackerX.publicKey,
		});

		let signedBytes: Uint8Array | null = null;
		const respond = makeLanChallengeResponder({
			deviceAccount: () => b64url(device.publicKey),
			signWithDeviceKey: (msg) => {
				signedBytes = msg;
				return signPayload(device.secretKey, msg);
			},
		});

		expect(await respond(b64url(canonicalAddDeviceBytes(input)))).toBeNull();
		expect(signedBytes).toBeNull(); // the key was never asked to sign at all
	});

	it("the cloud responder REFUSES to sign roster-shaped bytes", async () => {
		const user = generateIdentity();
		const attackerEd = generateIdentity();
		const attackerX = generateIdentity();
		const input = attackerRecordInput(user.publicKey, {
			ed: attackerEd.publicKey,
			x: attackerX.publicKey,
		});

		let signedBytes: Uint8Array | null = null;
		const respond = makeChallengeResponder({
			account: () => b64url(user.publicKey),
			signNonce: (nonce) => {
				signedBytes = nonce;
				return signPayload(user.secretKey, nonce);
			},
			loadToken: () => "entitlement-token",
		});

		expect(await respond(b64url(canonicalAddDeviceBytes(input)))).toBeNull();
		expect(signedBytes).toBeNull();
	});

	it("even a 32-byte nonce yields a LAN signature that is not a roster record", async () => {
		// Belt-and-braces: the length guard alone would let a hypothetical
		// 32-byte signable message through; the domain tag closes that too.
		const device = generateIdentity();
		const respond = makeLanChallengeResponder({
			deviceAccount: () => b64url(device.publicKey),
			signWithDeviceKey: (msg) => signPayload(device.secretKey, msg),
		});
		const nonce = new Uint8Array(32).fill(3);
		const reply = await respond(b64url(nonce));
		const sig = new Uint8Array(Buffer.from((reply as { sig: string }).sig, "base64url"));
		// The signature does NOT verify over the bare nonce — only over the
		// tagged bytes — so it can never be replayed into an untagged protocol.
		expect(ed25519Verify(device.publicKey, nonce, sig)).toBe(false);
	});

	it("signs the domain-tagged nonce, so an honest verifier still validates it", async () => {
		const device = generateIdentity();
		const nonce = new Uint8Array(32).fill(7);

		const respond = makeLanChallengeResponder({
			deviceAccount: () => b64url(device.publicKey),
			signWithDeviceKey: (bytes) => signPayload(device.secretKey, bytes),
		});
		const reply = await respond(b64url(nonce));
		expect(reply).not.toBeNull();

		const signed = new Uint8Array([...CHALLENGE_DOMAIN_TAG, ...nonce]);
		const sig = new Uint8Array(Buffer.from((reply as { sig: string }).sig, "base64url"));
		expect(ed25519Verify(device.publicKey, signed, sig)).toBe(true);
		// …and the bare nonce alone does NOT verify — proof the tag is in the message.
		expect(ed25519Verify(device.publicKey, nonce, sig)).toBe(false);
	});
});
