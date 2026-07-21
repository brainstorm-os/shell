import { x25519 as nobleX25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";

type Native = {
	x25519GetPublicKey: (secret: Uint8Array) => Uint8Array;
	x25519GetSharedSecret: (secret: Uint8Array, publicKey: Uint8Array) => Uint8Array;
};

const loadNative = async (): Promise<Native> => (await import("../index.js")) as unknown as Native;

const hex = (bytes: Uint8Array) =>
	Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

const SECRETS = [
	new Uint8Array(32).fill(0x01),
	new Uint8Array(32).fill(0xff),
	new Uint8Array(32).map((_, i) => i),
	new Uint8Array(32).map((_, i) => (i * 17) & 0xff),
] as const;

describe("@brainstorm-os/native — x25519 (NAPI-3c)", () => {
	it("derives the same public key as @noble/curves x25519 across fixed secrets", async () => {
		const { x25519GetPublicKey } = await loadNative();
		for (const secret of SECRETS) {
			const rust = x25519GetPublicKey(secret);
			const noble = nobleX25519.getPublicKey(secret);
			expect(rust.length).toBe(32);
			expect(hex(rust)).toBe(hex(noble));
		}
	});

	it("computes byte-identical shared secrets across every (secret, peer-pub) pair", async () => {
		const { x25519GetPublicKey, x25519GetSharedSecret } = await loadNative();
		// Pre-derive every public key once.
		const publics = SECRETS.map((s) => x25519GetPublicKey(s));
		for (let i = 0; i < SECRETS.length; i++) {
			for (let j = 0; j < SECRETS.length; j++) {
				if (i === j) continue;
				// biome-ignore lint/style/noNonNullAssertion: indices in bounds
				const aSec = SECRETS[i]!;
				// biome-ignore lint/style/noNonNullAssertion: indices in bounds
				const bPub = publics[j]!;
				const rust = x25519GetSharedSecret(aSec, bPub);
				const noble = nobleX25519.getSharedSecret(aSec, bPub);
				expect(rust.length).toBe(32);
				expect(hex(rust), `pair ${i}→${j}`).toBe(hex(noble));
			}
		}
	});

	it("DH is symmetric: shared(a, B) == shared(b, A)", async () => {
		const { x25519GetPublicKey, x25519GetSharedSecret } = await loadNative();
		const aSec = new Uint8Array(32).fill(0x55);
		const bSec = new Uint8Array(32).fill(0xaa);
		const aPub = x25519GetPublicKey(aSec);
		const bPub = x25519GetPublicKey(bSec);
		const sharedFromA = x25519GetSharedSecret(aSec, bPub);
		const sharedFromB = x25519GetSharedSecret(bSec, aPub);
		expect(hex(sharedFromA)).toBe(hex(sharedFromB));
	});

	it("interops with @noble both directions (cross-impl DH)", async () => {
		const { x25519GetPublicKey, x25519GetSharedSecret } = await loadNative();
		const aSec = new Uint8Array(32).map((_, i) => i + 7);
		const bSec = new Uint8Array(32).map((_, i) => (i + 13) & 0xff);

		// Rust derives Alice's pubkey; @noble derives Bob's pubkey; both sides DH and compare.
		const aPubRust = x25519GetPublicKey(aSec);
		const bPubNoble = nobleX25519.getPublicKey(bSec);

		const sharedRust = x25519GetSharedSecret(aSec, bPubNoble);
		const sharedNoble = nobleX25519.getSharedSecret(bSec, aPubRust);
		expect(hex(sharedRust)).toBe(hex(sharedNoble));
	});

	it("rejects wrong-length inputs with InvalidArg", async () => {
		const { x25519GetPublicKey, x25519GetSharedSecret } = await loadNative();
		expect(() => x25519GetPublicKey(new Uint8Array(31))).toThrow(/32 bytes/);
		expect(() => x25519GetPublicKey(new Uint8Array(33))).toThrow(/32 bytes/);
		expect(() => x25519GetSharedSecret(new Uint8Array(31), new Uint8Array(32))).toThrow(/secret/);
		expect(() => x25519GetSharedSecret(new Uint8Array(32), new Uint8Array(31))).toThrow(/public key/);
	});

	it("rejects low-order peer pubkeys (RFC 7748 §6.1 small-subgroup defence) — matches @noble's throw", async () => {
		const { x25519GetSharedSecret } = await loadNative();
		// The all-zero point is in the small subgroup of curve25519; using it
		// as a peer pubkey would yield an all-zero shared secret, which a
		// malicious peer can force to fix the DH output. @noble rejects
		// upfront ("invalid private or public key received"); the Rust
		// binding rejects post-scalar-mult on the all-zero output. Both
		// throw — the contract is "no zero-DH ever flows to HKDF".
		const lowOrder = new Uint8Array(32);
		const aSec = new Uint8Array(32).fill(0x42);
		expect(() => x25519GetSharedSecret(aSec, lowOrder)).toThrow(/small subgroup|all-zero/i);
		expect(() => nobleX25519.getSharedSecret(aSec, lowOrder)).toThrow();
	});
});
