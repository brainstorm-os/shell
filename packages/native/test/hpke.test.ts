import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 as nobleX25519 } from "@noble/curves/ed25519.js";
import { expand, extract } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";

type Native = {
	hpkeSealBase: (
		pkR: Uint8Array,
		info: Uint8Array,
		aad: Uint8Array,
		pt: Uint8Array,
		ephemeralSecret?: Uint8Array | null,
	) => { enc: Uint8Array; ct: Uint8Array };
	hpkeOpenBase: (
		enc: Uint8Array,
		skR: Uint8Array,
		info: Uint8Array,
		aad: Uint8Array,
		ct: Uint8Array,
	) => Uint8Array;
	x25519GetPublicKey: (secret: Uint8Array) => Uint8Array;
	x25519GetSharedSecret: (secret: Uint8Array, publicKey: Uint8Array) => Uint8Array;
};

const loadNative = async (): Promise<Native> => (await import("../index.js")) as unknown as Native;

const hex = (bytes: Uint8Array) =>
	Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

const fromHex = (s: string): Uint8Array => {
	const clean = s.replace(/\s+/g, "");
	const out = new Uint8Array(clean.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.substr(i * 2, 2), 16);
	return out;
};

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
};

// ── @noble-composed reference HPKE (parity oracle for cross-impl tests) ──
//
// Mirrors the @noble construction that lived in
// packages/shell/src/main/credentials/hpke.ts before the NAPI swap. Kept
// inline in the test file so the native test gets a self-contained second
// implementation to compare against (RFC 9180 KAT pins the absolute byte
// truth; this oracle pins relative byte parity for arbitrary inputs).

const HPKE_KEM_ID = 0x0020;
const HPKE_KDF_ID = 0x0001;
const HPKE_AEAD_ID = 0x0003;
const HPKE_N_K = 32;
const HPKE_N_N = 12;
const EMPTY = new Uint8Array(0);
const utf8 = (s: string) => new TextEncoder().encode(s);
const HPKE_VERSION = utf8("HPKE-v1");
const i2osp2 = (v: number) => new Uint8Array([(v >>> 8) & 0xff, v & 0xff]);
const concat = (...parts: Uint8Array[]) => {
	let total = 0;
	for (const p of parts) total += p.length;
	const out = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
};
const SUITE_ID_KEM = concat(utf8("KEM"), i2osp2(HPKE_KEM_ID));
const SUITE_ID_HPKE = concat(
	utf8("HPKE"),
	i2osp2(HPKE_KEM_ID),
	i2osp2(HPKE_KDF_ID),
	i2osp2(HPKE_AEAD_ID),
);

const labeledExtract = (salt: Uint8Array, label: Uint8Array, ikm: Uint8Array, suite: Uint8Array) =>
	extract(sha256, concat(HPKE_VERSION, suite, label, ikm), salt);

const labeledExpand = (
	prk: Uint8Array,
	label: Uint8Array,
	info: Uint8Array,
	length: number,
	suite: Uint8Array,
) => expand(sha256, prk, concat(i2osp2(length), HPKE_VERSION, suite, label, info), length);

const nobleSealBase = (
	pkR: Uint8Array,
	info: Uint8Array,
	aad: Uint8Array,
	pt: Uint8Array,
	skE: Uint8Array,
): { enc: Uint8Array; ct: Uint8Array } => {
	const pkE = new Uint8Array(nobleX25519.getPublicKey(skE));
	const dh = new Uint8Array(nobleX25519.getSharedSecret(skE, pkR));
	const kemContext = concat(pkE, pkR);
	const eaePrk = labeledExtract(EMPTY, utf8("eae_prk"), dh, SUITE_ID_KEM);
	const sharedSecret = labeledExpand(eaePrk, utf8("shared_secret"), kemContext, 32, SUITE_ID_KEM);
	const pskIdHash = labeledExtract(EMPTY, utf8("psk_id_hash"), EMPTY, SUITE_ID_HPKE);
	const infoHash = labeledExtract(EMPTY, utf8("info_hash"), info, SUITE_ID_HPKE);
	const ksCtx = concat(new Uint8Array([0x00]), pskIdHash, infoHash);
	const secret = labeledExtract(sharedSecret, utf8("secret"), EMPTY, SUITE_ID_HPKE);
	const key = labeledExpand(secret, utf8("key"), ksCtx, HPKE_N_K, SUITE_ID_HPKE);
	const baseNonce = labeledExpand(secret, utf8("base_nonce"), ksCtx, HPKE_N_N, SUITE_ID_HPKE);
	const ct = chacha20poly1305(key, baseNonce, aad).encrypt(pt);
	return { enc: pkE, ct };
};

const nobleOpenBase = (
	enc: Uint8Array,
	skR: Uint8Array,
	info: Uint8Array,
	aad: Uint8Array,
	ct: Uint8Array,
): Uint8Array => {
	const pkR = new Uint8Array(nobleX25519.getPublicKey(skR));
	const dh = new Uint8Array(nobleX25519.getSharedSecret(skR, enc));
	const kemContext = concat(enc, pkR);
	const eaePrk = labeledExtract(EMPTY, utf8("eae_prk"), dh, SUITE_ID_KEM);
	const sharedSecret = labeledExpand(eaePrk, utf8("shared_secret"), kemContext, 32, SUITE_ID_KEM);
	const pskIdHash = labeledExtract(EMPTY, utf8("psk_id_hash"), EMPTY, SUITE_ID_HPKE);
	const infoHash = labeledExtract(EMPTY, utf8("info_hash"), info, SUITE_ID_HPKE);
	const ksCtx = concat(new Uint8Array([0x00]), pskIdHash, infoHash);
	const secret = labeledExtract(sharedSecret, utf8("secret"), EMPTY, SUITE_ID_HPKE);
	const key = labeledExpand(secret, utf8("key"), ksCtx, HPKE_N_K, SUITE_ID_HPKE);
	const baseNonce = labeledExpand(secret, utf8("base_nonce"), ksCtx, HPKE_N_N, SUITE_ID_HPKE);
	return chacha20poly1305(key, baseNonce, aad).decrypt(ct);
};

describe("@brainstorm-os/native — HPKE base mode (NAPI-3d)", () => {
	it("matches the RFC 9180 A.2.1 base-mode test vector at sequence 0", async () => {
		const { hpkeSealBase, hpkeOpenBase } = await loadNative();
		const info = fromHex("4f6465206f6e2061204772656369616e2055726e");
		const skEm = fromHex("f4ec9b33b792c372c1d2c2063507b684ef925b8c75a42dbcbf57d63ccd381600");
		const pkRm = fromHex("4310ee97d88cc1f088a5576c77ab0cf5c3ac797f3d95139c6c84b5429c59662a");
		const skRm = fromHex("8057991eef8f1f1af18f4a9491d16a1ce333f695d4db8e38da75975c4478e0fb");
		const expectedEnc = fromHex("1afa08d3dec047a643885163f1180476fa7ddb54c6a8029ea33f95796bf2ac4a");
		const pt = fromHex("4265617574792069732074727574682c20747275746820626561757479");
		const aad = fromHex("436f756e742d30");
		const expectedCt = fromHex(
			"1c5250d8034ec2b784ba2cfd69dbdb8af406cfe3ff938e131f0def8c8b60b4db21993c62ce81883d2dd1b51a28",
		);

		const sealed = hpkeSealBase(pkRm, info, aad, pt, skEm);
		expect(hex(sealed.enc)).toBe(hex(expectedEnc));
		expect(hex(sealed.ct)).toBe(hex(expectedCt));

		const recovered = hpkeOpenBase(sealed.enc, skRm, info, aad, sealed.ct);
		expect(hex(recovered)).toBe(hex(pt));
	});

	it("byte-identical to @noble suite for fixed deterministic-ephemeral tuples", async () => {
		const { hpkeSealBase } = await loadNative();
		const tuples = [
			{
				skE: new Uint8Array(32).fill(0x11),
				skR: new Uint8Array(32).fill(0x22),
				info: utf8("alpha"),
				aad: utf8("aad-1"),
				pt: utf8("hello hpke parity"),
			},
			{
				skE: new Uint8Array(32).map((_, i) => (i * 7) & 0xff),
				skR: new Uint8Array(32).map((_, i) => (i * 13) & 0xff),
				info: new Uint8Array(0),
				aad: new Uint8Array(0),
				pt: new Uint8Array(64).map((_, i) => (i + 3) & 0xff),
			},
		] as const;
		for (const t of tuples) {
			const pkR = new Uint8Array(nobleX25519.getPublicKey(t.skR));
			const rust = hpkeSealBase(pkR, t.info, t.aad, t.pt, t.skE);
			const noble = nobleSealBase(pkR, t.info, t.aad, t.pt, t.skE);
			expect(hex(rust.enc)).toBe(hex(noble.enc));
			expect(hex(rust.ct)).toBe(hex(noble.ct));
		}
	});

	it("round-trips 8x with CSPRNG ephemerals + random inputs", async () => {
		const { hpkeSealBase, hpkeOpenBase } = await loadNative();
		for (let i = 0; i < 8; i++) {
			const skR = new Uint8Array(32);
			crypto.getRandomValues(skR);
			const pkR = new Uint8Array(nobleX25519.getPublicKey(skR));
			const info = crypto.getRandomValues(new Uint8Array(16));
			const aad = crypto.getRandomValues(new Uint8Array(8));
			const pt = crypto.getRandomValues(new Uint8Array(32));
			const sealed = hpkeSealBase(pkR, info, aad, pt, null);
			expect(sealed.enc.length).toBe(32);
			expect(sealed.ct.length).toBe(pt.length + 16);
			const opened = hpkeOpenBase(sealed.enc, skR, info, aad, sealed.ct);
			expect(bytesEqual(opened, pt)).toBe(true);
		}
	});

	it("interops with @noble both directions (cross-impl seal/open)", async () => {
		const { hpkeSealBase, hpkeOpenBase } = await loadNative();
		const skR = new Uint8Array(32).fill(0x33);
		const pkR = new Uint8Array(nobleX25519.getPublicKey(skR));
		const info = utf8("interop-info");
		const aad = utf8("interop-aad");
		const pt = utf8("cross-impl interop body");

		// Rust seal → @noble open
		const skE1 = new Uint8Array(32).fill(0x55);
		const rustSealed = hpkeSealBase(pkR, info, aad, pt, skE1);
		const nobleOpened = nobleOpenBase(rustSealed.enc, skR, info, aad, rustSealed.ct);
		expect(hex(nobleOpened)).toBe(hex(pt));

		// @noble seal → Rust open
		const skE2 = new Uint8Array(32).fill(0x77);
		const nobleSealed = nobleSealBase(pkR, info, aad, pt, skE2);
		const rustOpened = hpkeOpenBase(nobleSealed.enc, skR, info, aad, nobleSealed.ct);
		expect(hex(rustOpened)).toBe(hex(pt));
	});

	it("OpenBase throws for the wrong recipient secret key", async () => {
		const { hpkeSealBase, hpkeOpenBase } = await loadNative();
		const skR1 = new Uint8Array(32).fill(0x44);
		const skR2 = new Uint8Array(32).fill(0x55);
		const pkR1 = new Uint8Array(nobleX25519.getPublicKey(skR1));
		const sealed = hpkeSealBase(
			pkR1,
			new Uint8Array([1]),
			new Uint8Array([2]),
			new Uint8Array([3, 4, 5]),
			null,
		);
		expect(() =>
			hpkeOpenBase(sealed.enc, skR2, new Uint8Array([1]), new Uint8Array([2]), sealed.ct),
		).toThrow();
	});

	it("OpenBase throws for a mismatched info string", async () => {
		const { hpkeSealBase, hpkeOpenBase } = await loadNative();
		const skR = new Uint8Array(32).fill(0x66);
		const pkR = new Uint8Array(nobleX25519.getPublicKey(skR));
		const sealed = hpkeSealBase(
			pkR,
			new Uint8Array([1]),
			new Uint8Array([2]),
			new Uint8Array([3]),
			null,
		);
		expect(() =>
			hpkeOpenBase(sealed.enc, skR, new Uint8Array([9]), new Uint8Array([2]), sealed.ct),
		).toThrow();
	});

	it("OpenBase throws for a mismatched aad", async () => {
		const { hpkeSealBase, hpkeOpenBase } = await loadNative();
		const skR = new Uint8Array(32).fill(0x77);
		const pkR = new Uint8Array(nobleX25519.getPublicKey(skR));
		const sealed = hpkeSealBase(
			pkR,
			new Uint8Array([1]),
			new Uint8Array([2]),
			new Uint8Array([3]),
			null,
		);
		expect(() =>
			hpkeOpenBase(sealed.enc, skR, new Uint8Array([1]), new Uint8Array([9]), sealed.ct),
		).toThrow();
	});

	it("OpenBase throws on tampered ciphertext (Poly1305 auth failure)", async () => {
		const { hpkeSealBase, hpkeOpenBase } = await loadNative();
		const skR = new Uint8Array(32).fill(0x88);
		const pkR = new Uint8Array(nobleX25519.getPublicKey(skR));
		const sealed = hpkeSealBase(
			pkR,
			new Uint8Array([1]),
			new Uint8Array([2]),
			new Uint8Array([3, 4, 5]),
			null,
		);
		const tampered = new Uint8Array(sealed.ct);
		tampered[0] = (tampered[0] ?? 0) ^ 1;
		expect(() =>
			hpkeOpenBase(sealed.enc, skR, new Uint8Array([1]), new Uint8Array([2]), tampered),
		).toThrow();
	});

	it("rejects malformed lengths with /32 bytes/", async () => {
		const { hpkeSealBase, hpkeOpenBase } = await loadNative();
		expect(() =>
			hpkeSealBase(
				new Uint8Array(31),
				new Uint8Array(0),
				new Uint8Array(0),
				new Uint8Array([1]),
				null,
			),
		).toThrow(/32 bytes/);
		const skR = new Uint8Array(32).fill(0x99);
		const pkR = new Uint8Array(nobleX25519.getPublicKey(skR));
		const sealed = hpkeSealBase(pkR, new Uint8Array(0), new Uint8Array(0), new Uint8Array([1]), null);
		expect(() =>
			hpkeOpenBase(sealed.enc, new Uint8Array(33), new Uint8Array(0), new Uint8Array(0), sealed.ct),
		).toThrow(/32 bytes/);
		expect(() =>
			hpkeOpenBase(new Uint8Array(31), skR, new Uint8Array(0), new Uint8Array(0), sealed.ct),
		).toThrow(/32 bytes/);
	});

	it("CSPRNG ephemerals produce different enc + ct every call", async () => {
		const { hpkeSealBase } = await loadNative();
		const skR = new Uint8Array(32).fill(0xaa);
		const pkR = new Uint8Array(nobleX25519.getPublicKey(skR));
		const a = hpkeSealBase(pkR, new Uint8Array(0), new Uint8Array(0), new Uint8Array([1]), null);
		const b = hpkeSealBase(pkR, new Uint8Array(0), new Uint8Array(0), new Uint8Array([1]), null);
		expect(bytesEqual(a.enc, b.enc)).toBe(false);
		expect(bytesEqual(a.ct, b.ct)).toBe(false);
	});
});
