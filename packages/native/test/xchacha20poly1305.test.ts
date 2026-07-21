import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { describe, expect, it } from "vitest";

type Native = {
	xchacha20Poly1305Seal: (
		key: Uint8Array,
		nonce: Uint8Array,
		plaintext: Uint8Array,
		aad: Uint8Array,
	) => Uint8Array;
	xchacha20Poly1305Open: (
		key: Uint8Array,
		nonce: Uint8Array,
		ciphertext: Uint8Array,
		aad: Uint8Array,
	) => Uint8Array;
};

const loadNative = async (): Promise<Native> => (await import("../index.js")) as unknown as Native;

const hex = (bytes: Uint8Array) =>
	Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
};

const EMPTY = new Uint8Array(0);

describe("@brainstorm-os/native — XChaCha20-Poly1305 (NAPI-3e)", () => {
	it("native seal === @noble xchacha20poly1305 encrypt BYTE-FOR-BYTE over random tuples (incl. empty aad)", async () => {
		const { xchacha20Poly1305Seal } = await loadNative();
		for (let i = 0; i < 16; i++) {
			const key = crypto.getRandomValues(new Uint8Array(32));
			const nonce = crypto.getRandomValues(new Uint8Array(24));
			const ptLen = (i * 11) % 97;
			const pt = crypto.getRandomValues(new Uint8Array(ptLen));
			// alternate: empty aad on even iterations, random aad on odd
			const aad = i % 2 === 0 ? EMPTY : crypto.getRandomValues(new Uint8Array(1 + (i % 7)));

			const nobleCt = xchacha20poly1305(key, nonce, aad).encrypt(pt);
			const nativeCt = xchacha20Poly1305Seal(key, nonce, pt, aad);
			expect(hex(nativeCt)).toBe(hex(nobleCt));
			expect(nativeCt.length).toBe(pt.length + 16);
		}
	});

	it("empty aad equals no-aad for this AEAD (native seal === @noble with undefined aad)", async () => {
		const { xchacha20Poly1305Seal } = await loadNative();
		const key = new Uint8Array(32).fill(0x11);
		const nonce = new Uint8Array(24).fill(0x22);
		const pt = new TextEncoder().encode("empty-aad equivalence");
		const nobleNoAad = xchacha20poly1305(key, nonce).encrypt(pt);
		const nobleEmptyAad = xchacha20poly1305(key, nonce, EMPTY).encrypt(pt);
		const nativeEmptyAad = xchacha20Poly1305Seal(key, nonce, pt, EMPTY);
		expect(hex(nobleEmptyAad)).toBe(hex(nobleNoAad));
		expect(hex(nativeEmptyAad)).toBe(hex(nobleNoAad));
	});

	it("native open(noble-sealed) === plaintext, and noble open(native-sealed) === plaintext", async () => {
		const { xchacha20Poly1305Seal, xchacha20Poly1305Open } = await loadNative();
		for (let i = 0; i < 16; i++) {
			const key = crypto.getRandomValues(new Uint8Array(32));
			const nonce = crypto.getRandomValues(new Uint8Array(24));
			const pt = crypto.getRandomValues(new Uint8Array((i * 13) % 71));
			const aad = i % 3 === 0 ? EMPTY : crypto.getRandomValues(new Uint8Array(1 + (i % 5)));

			// noble seal → native open
			const nobleCt = xchacha20poly1305(key, nonce, aad).encrypt(pt);
			const nativeOpened = xchacha20Poly1305Open(key, nonce, nobleCt, aad);
			expect(bytesEqual(nativeOpened, pt)).toBe(true);

			// native seal → noble open
			const nativeCt = xchacha20Poly1305Seal(key, nonce, pt, aad);
			const nobleOpened = xchacha20poly1305(key, nonce, aad).decrypt(nativeCt);
			expect(bytesEqual(nobleOpened, pt)).toBe(true);

			// native round-trip
			const nativeRoundTrip = xchacha20Poly1305Open(key, nonce, nativeCt, aad);
			expect(bytesEqual(nativeRoundTrip, pt)).toBe(true);
		}
	});

	it("open throws on tampered ciphertext (Poly1305 auth failure)", async () => {
		const { xchacha20Poly1305Seal, xchacha20Poly1305Open } = await loadNative();
		const key = new Uint8Array(32).fill(0x33);
		const nonce = new Uint8Array(24).fill(0x44);
		const pt = new Uint8Array([1, 2, 3, 4, 5]);
		const ct = xchacha20Poly1305Seal(key, nonce, pt, EMPTY);
		const tampered = new Uint8Array(ct);
		tampered[0] = (tampered[0] ?? 0) ^ 1;
		expect(() => xchacha20Poly1305Open(key, nonce, tampered, EMPTY)).toThrow();
	});

	it("open throws on wrong key and wrong aad", async () => {
		const { xchacha20Poly1305Seal, xchacha20Poly1305Open } = await loadNative();
		const key = new Uint8Array(32).fill(0x55);
		const wrongKey = new Uint8Array(32).fill(0x56);
		const nonce = new Uint8Array(24).fill(0x66);
		const pt = new Uint8Array([9, 8, 7]);
		const aad = new Uint8Array([0xaa, 0xbb]);
		const ct = xchacha20Poly1305Seal(key, nonce, pt, aad);
		expect(() => xchacha20Poly1305Open(wrongKey, nonce, ct, aad)).toThrow();
		expect(() => xchacha20Poly1305Open(key, nonce, ct, new Uint8Array([0xaa, 0xbc]))).toThrow();
	});

	it("rejects malformed key/nonce lengths", async () => {
		const { xchacha20Poly1305Seal } = await loadNative();
		expect(() =>
			xchacha20Poly1305Seal(new Uint8Array(31), new Uint8Array(24), new Uint8Array([1]), EMPTY),
		).toThrow(/32 bytes/);
		expect(() =>
			xchacha20Poly1305Seal(new Uint8Array(32), new Uint8Array(12), new Uint8Array([1]), EMPTY),
		).toThrow(/24 bytes/);
	});
});
