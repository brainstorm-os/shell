import { hkdf as nobleHkdf } from "@noble/hashes/hkdf.js";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";

type Native = {
	sha256: (input: Uint8Array) => Uint8Array;
	hkdfSha256: (
		ikm: Uint8Array,
		salt: Uint8Array | null | undefined,
		info: Uint8Array,
		outLen: number,
	) => Uint8Array;
};

const loadNative = async (): Promise<Native> => (await import("../index.js")) as unknown as Native;

const hex = (bytes: Uint8Array) =>
	Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("@brainstorm-os/native — sha256 (NAPI-3b)", () => {
	it("matches @noble/hashes/sha2.js on the empty input (FIPS 180-4 anchor: e3b0c44…)", async () => {
		const { sha256 } = await loadNative();
		const empty = new Uint8Array(0);
		const rust = sha256(empty);
		const noble = nobleSha256(empty);
		expect(rust.length).toBe(32);
		expect(hex(rust)).toBe(hex(noble));
		expect(hex(rust)).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	});

	it("matches @noble across a sweep of representative inputs", async () => {
		const { sha256 } = await loadNative();
		const inputs = [
			utf8("a"),
			utf8("abc"),
			utf8("brainstorm vault fingerprint preimage"),
			new Uint8Array(1).fill(0),
			new Uint8Array(32).map((_, i) => i),
			new Uint8Array(64).fill(0xff),
			new Uint8Array(1024).map((_, i) => (i * 31) & 0xff),
			// 1 MiB — exercises the streaming/block path
			new Uint8Array(1024 * 1024).map((_, i) => (i * 7) & 0xff),
		];
		for (const input of inputs) {
			const rust = sha256(input);
			const noble = nobleSha256(input);
			expect(hex(rust)).toBe(hex(noble));
		}
	});

	it("is deterministic", async () => {
		const { sha256 } = await loadNative();
		const input = utf8("repeatable");
		expect(hex(sha256(input))).toBe(hex(sha256(input)));
	});
});

describe("@brainstorm-os/native — hkdfSha256 (NAPI-3b)", () => {
	it("matches @noble/hashes/hkdf.js across the pairing / at-rest call shapes", async () => {
		const { hkdfSha256 } = await loadNative();
		const cases: { ikm: Uint8Array; salt?: Uint8Array; info: Uint8Array; outLen: number }[] = [
			// pairing/sas.ts (no salt, short info, 32-byte output)
			{ ikm: new Uint8Array(32).fill(0x11), info: utf8("sas-v1"), outLen: 32 },
			// at-rest-key.ts (explicit 32-byte salt + per-DB info, 32-byte output)
			{
				ikm: new Uint8Array(32).fill(0x22),
				salt: new Uint8Array(32).map((_, i) => i + 1),
				info: utf8("brainstorm/v1/at-rest/entities"),
				outLen: 32,
			},
			// pairing-handshake.ts (no salt, 32-byte output)
			{
				ikm: new Uint8Array(32).fill(0x33),
				info: utf8("brainstorm/v1/pair/secret"),
				outLen: 32,
			},
			// Long output (multi-block expand)
			{
				ikm: utf8("ikm-bytes"),
				salt: utf8("salt-bytes"),
				info: utf8("info-bytes"),
				outLen: 96,
			},
		];
		for (const c of cases) {
			const rust = hkdfSha256(c.ikm, c.salt ?? null, c.info, c.outLen);
			const noble = nobleHkdf(nobleSha256, c.ikm, c.salt, c.info, c.outLen);
			expect(rust.length, `outLen=${c.outLen}`).toBe(c.outLen);
			expect(hex(rust)).toBe(hex(noble));
		}
	});

	it("treats undefined / null / empty salt identically (RFC 5869 §3.1 = HashLen zeros)", async () => {
		const { hkdfSha256 } = await loadNative();
		const ikm = utf8("ikm");
		const info = utf8("info");
		const a = hkdfSha256(ikm, undefined, info, 32);
		const b = hkdfSha256(ikm, null, info, 32);
		const c = hkdfSha256(ikm, new Uint8Array(0), info, 32);
		const noble = nobleHkdf(nobleSha256, ikm, undefined, info, 32);
		expect(hex(a)).toBe(hex(b));
		expect(hex(a)).toBe(hex(c));
		expect(hex(a)).toBe(hex(noble));
	});

	it("rejects out_len = 0 with a clear error", async () => {
		const { hkdfSha256 } = await loadNative();
		expect(() => hkdfSha256(utf8("ikm"), null, utf8("info"), 0)).toThrow(/out_len/);
	});

	it("rejects an out_len that exceeds the HKDF expand cap (255 * HashLen = 8160 for SHA-256)", async () => {
		const { hkdfSha256 } = await loadNative();
		expect(() => hkdfSha256(utf8("ikm"), null, utf8("info"), 8161)).toThrow();
	});
});
