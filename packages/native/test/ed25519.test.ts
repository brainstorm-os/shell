import { ed25519 as nobleEd25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it } from "vitest";

type Native = {
	ed25519GetPublicKey: (seed: Uint8Array) => Uint8Array;
	ed25519Sign: (seed: Uint8Array, payload: Uint8Array) => Uint8Array;
	ed25519Verify: (publicKey: Uint8Array, payload: Uint8Array, signature: Uint8Array) => boolean;
};

const loadNative = async (): Promise<Native> => (await import("../index.js")) as unknown as Native;

const hex = (bytes: Uint8Array) =>
	Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

const utf8 = (s: string) => new TextEncoder().encode(s);

// Deterministic fixture seeds — Ed25519 is content-addressable so these
// double as KAT pins for the public key + signature shapes.
const SEEDS = [
	new Uint8Array(32).fill(0),
	new Uint8Array(32).fill(0xff),
	new Uint8Array(32).map((_, i) => i),
	new Uint8Array(32).map((_, i) => (i * 31) & 0xff),
] as const;

describe("@brainstorm-os/native — ed25519 (NAPI-3a)", () => {
	it("derives the same public key as @noble/curves/ed25519.js across fixed seeds", async () => {
		const { ed25519GetPublicKey } = await loadNative();
		for (const seed of SEEDS) {
			const rust = ed25519GetPublicKey(seed);
			const noble = nobleEd25519.getPublicKey(seed);
			expect(rust.length).toBe(32);
			expect(hex(rust)).toBe(hex(noble));
		}
	});

	it("produces signatures byte-identical to @noble across fixed seed + payload pairs", async () => {
		const { ed25519Sign } = await loadNative();
		const payloads = [
			utf8(""),
			utf8("a"),
			utf8("brainstorm vault unlock challenge"),
			new Uint8Array(1024).map((_, i) => (i * 17) & 0xff),
		];
		for (const seed of SEEDS) {
			for (const payload of payloads) {
				const rust = ed25519Sign(seed, payload);
				const noble = nobleEd25519.sign(payload, seed);
				expect(rust.length).toBe(64);
				expect(hex(rust)).toBe(hex(noble));
			}
		}
	});

	it("verifies a Rust-produced signature with @noble (and vice versa)", async () => {
		const { ed25519GetPublicKey, ed25519Sign, ed25519Verify } = await loadNative();
		const seed = new Uint8Array(32).map((_, i) => i + 1);
		const payload = utf8("envelope-1");
		const publicKey = ed25519GetPublicKey(seed);

		// Rust signs → both Rust and @noble verify
		const rustSig = ed25519Sign(seed, payload);
		expect(ed25519Verify(publicKey, payload, rustSig)).toBe(true);
		expect(nobleEd25519.verify(rustSig, payload, publicKey)).toBe(true);

		// @noble signs → both verify
		const nobleSig = nobleEd25519.sign(payload, seed);
		expect(ed25519Verify(publicKey, payload, nobleSig)).toBe(true);
		expect(nobleEd25519.verify(nobleSig, payload, publicKey)).toBe(true);
	});

	it("rejects a signature whose payload differs even by one bit", async () => {
		const { ed25519GetPublicKey, ed25519Sign, ed25519Verify } = await loadNative();
		const seed = new Uint8Array(32).fill(0x42);
		const publicKey = ed25519GetPublicKey(seed);
		const payload = utf8("envelope-payload");
		const sig = ed25519Sign(seed, payload);
		const tampered = new Uint8Array(payload);
		const lastIndex = tampered.length - 1;
		// biome-ignore lint/style/noNonNullAssertion: index inside the array bounds
		tampered[lastIndex] = tampered[lastIndex]! ^ 0x01;
		expect(ed25519Verify(publicKey, tampered, sig)).toBe(false);
	});

	it("rejects a signature signed by a different seed", async () => {
		const { ed25519GetPublicKey, ed25519Sign, ed25519Verify } = await loadNative();
		const seedA = new Uint8Array(32).fill(0x11);
		const seedB = new Uint8Array(32).fill(0x22);
		const payload = utf8("envelope-x");
		const publicKeyA = ed25519GetPublicKey(seedA);
		const sigByB = ed25519Sign(seedB, payload);
		expect(ed25519Verify(publicKeyA, payload, sigByB)).toBe(false);
	});

	it("rejects (never throws) on malformed key / signature lengths", async () => {
		const { ed25519Verify } = await loadNative();
		const validKey = new Uint8Array(32);
		const validSig = new Uint8Array(64);
		const payload = utf8("x");
		expect(ed25519Verify(new Uint8Array(31), payload, validSig)).toBe(false);
		expect(ed25519Verify(new Uint8Array(33), payload, validSig)).toBe(false);
		expect(ed25519Verify(validKey, payload, new Uint8Array(63))).toBe(false);
		expect(ed25519Verify(validKey, payload, new Uint8Array(65))).toBe(false);
		expect(ed25519Verify(new Uint8Array(0), payload, new Uint8Array(0))).toBe(false);
	});

	it("throws InvalidArg on wrong-length seed in sign / getPublicKey", async () => {
		const { ed25519GetPublicKey, ed25519Sign } = await loadNative();
		expect(() => ed25519GetPublicKey(new Uint8Array(31))).toThrow(/32 bytes/);
		expect(() => ed25519GetPublicKey(new Uint8Array(33))).toThrow(/32 bytes/);
		expect(() => ed25519Sign(new Uint8Array(31), utf8("p"))).toThrow(/32 bytes/);
	});
});
