import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateSymmetricKey } from "../credentials/crypto";
import {
	ASSET_CHUNK_BYTES,
	type AssetChunkManifest,
	chunkCount,
	openAssetChunks,
	openOneChunk,
	parseAssetChunkManifest,
	sealAssetChunks,
	sealOneChunk,
} from "./asset-chunks";

const ASSET = "asset-7f3a";
const CHUNK = 16; // tiny chunk size keeps the multi-chunk cases cheap

/** In-memory CAS: the sealed map IS the node store for round-trip tests. */
function casFrom(sealed: Map<string, Uint8Array>) {
	return async (hash: string) => sealed.get(hash) ?? null;
}

function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

describe("chunkCount", () => {
	it("is always at least 1 (a 0-byte blob is one empty chunk)", () => {
		expect(chunkCount(0, CHUNK)).toBe(1);
		expect(chunkCount(1, CHUNK)).toBe(1);
		expect(chunkCount(CHUNK, CHUNK)).toBe(1);
		expect(chunkCount(CHUNK + 1, CHUNK)).toBe(2);
		expect(chunkCount(3 * CHUNK, CHUNK)).toBe(3);
		expect(chunkCount(3 * CHUNK + 1, CHUNK)).toBe(4);
	});
	it("defaults to 4 MiB chunks", () => {
		expect(ASSET_CHUNK_BYTES).toBe(4 * 1024 * 1024);
		expect(chunkCount(4 * 1024 * 1024)).toBe(1);
		expect(chunkCount(4 * 1024 * 1024 + 1)).toBe(2);
	});
});

describe("seal → open round-trip", () => {
	const sizes = [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK, 3 * CHUNK + 7];
	for (const size of sizes) {
		it(`reassembles a ${size}-byte blob byte-identically`, async () => {
			const dek = generateSymmetricKey();
			const plain = new Uint8Array(randomBytes(size));
			const { manifest, sealed } = sealAssetChunks(plain, dek, ASSET, CHUNK);

			expect(manifest.v).toBe(1);
			expect(manifest.assetId).toBe(ASSET);
			expect(manifest.totalRawLen).toBe(size);
			expect(manifest.chunks.length).toBe(chunkCount(size, CHUNK));
			expect(manifest.chunks.reduce((n, c) => n + c.rawLen, 0)).toBe(size);
			// Every manifest hash is the sha256 of the sealed ciphertext it points at.
			for (const ref of manifest.chunks) {
				expect(sha256Hex(sealed.get(ref.hash) ?? new Uint8Array())).toBe(ref.hash);
				expect(ref.encLen).toBe(sealed.get(ref.hash)?.length);
			}

			const back = await openAssetChunks(manifest, dek, casFrom(sealed));
			expect(back.length).toBe(size);
			expect(Buffer.from(back).equals(Buffer.from(plain))).toBe(true);
		});
	}

	it("round-trips random blobs across a generative loop", async () => {
		for (let i = 0; i < 40; i += 1) {
			const dek = generateSymmetricKey();
			const size = Math.floor(Math.random() * (5 * CHUNK));
			const plain = new Uint8Array(randomBytes(size));
			const { manifest, sealed } = sealAssetChunks(plain, dek, `a${i}`, CHUNK);
			const back = await openAssetChunks(manifest, dek, casFrom(sealed));
			expect(Buffer.from(back).equals(Buffer.from(plain))).toBe(true);
		}
	});
});

describe("integrity + key binding", () => {
	it("rejects a tampered chunk (content-address mismatch)", async () => {
		const dek = generateSymmetricKey();
		const plain = new Uint8Array(randomBytes(2 * CHUNK));
		const { manifest, sealed } = sealAssetChunks(plain, dek, ASSET, CHUNK);
		// Flip a byte in the first sealed chunk WITHOUT changing the key it's
		// stored under — so the address no longer matches the bytes.
		const firstHash = manifest.chunks[0]?.hash ?? "";
		const enc = sealed.get(firstHash);
		if (enc && enc.length > 0) enc[enc.length - 1] = (enc[enc.length - 1] ?? 0) ^ 0xff;
		await expect(openAssetChunks(manifest, dek, casFrom(sealed))).rejects.toThrow(
			/content-address mismatch/,
		);
	});

	it("rejects a bit-flip that the address can't catch via the AEAD tag", async () => {
		const dek = generateSymmetricKey();
		const { ref, enc } = sealOneChunk(new Uint8Array(randomBytes(CHUNK)), dek, ASSET, 0);
		enc[0] = (enc[0] ?? 0) ^ 0x01; // mutate, then re-point the ref at the mutated bytes
		const tampered = { ...ref, hash: sha256Hex(enc) };
		expect(() => openOneChunk(enc, dek, ASSET, 0, tampered)).toThrow();
	});

	it("rejects the wrong DEK (AEAD failure)", async () => {
		const dek = generateSymmetricKey();
		const wrong = generateSymmetricKey();
		const plain = new Uint8Array(randomBytes(CHUNK + 3));
		const { manifest, sealed } = sealAssetChunks(plain, dek, ASSET, CHUNK);
		await expect(openAssetChunks(manifest, wrong, casFrom(sealed))).rejects.toThrow();
	});

	it("binds each chunk to its (assetId, index) — a chunk can't be opened at another index", () => {
		const dek = generateSymmetricKey();
		const { ref, enc } = sealOneChunk(new Uint8Array(randomBytes(CHUNK)), dek, ASSET, 2);
		// Same bytes + ref, but opened as index 3: the AAD differs → AEAD fails.
		expect(() => openOneChunk(enc, dek, ASSET, 3, ref)).toThrow();
		// And under a different asset id.
		expect(() => openOneChunk(enc, dek, "other-asset", 2, ref)).toThrow();
		// Correct (assetId, index) opens fine.
		expect(() => openOneChunk(enc, dek, ASSET, 2, ref)).not.toThrow();
	});

	it("throws when a manifest chunk is missing from the CAS", async () => {
		const dek = generateSymmetricKey();
		const plain = new Uint8Array(randomBytes(2 * CHUNK));
		const { manifest } = sealAssetChunks(plain, dek, ASSET, CHUNK);
		await expect(openAssetChunks(manifest, dek, async () => null)).rejects.toThrow(/not found/);
	});

	it("rejects an unknown manifest version", async () => {
		const dek = generateSymmetricKey();
		const bad = { v: 2, assetId: ASSET, chunkBytes: CHUNK, totalRawLen: 0, chunks: [] };
		await expect(
			openAssetChunks(bad as unknown as AssetChunkManifest, dek, async () => null),
		).rejects.toThrow(/unsupported manifest/);
	});
});

describe("deterministic content-addressing (resume + skip-already-present)", () => {
	it("re-seals the same chunk to the same address (stable for HAS-skip/resume)", () => {
		const dek = generateSymmetricKey();
		const raw = new Uint8Array(randomBytes(CHUNK));
		const a = sealOneChunk(raw, dek, ASSET, 5);
		const b = sealOneChunk(raw, dek, ASSET, 5);
		expect(b.ref.hash).toBe(a.ref.hash);
		expect(Buffer.from(b.enc).equals(Buffer.from(a.enc))).toBe(true);
	});

	it("different content / position / key yields a different address", () => {
		const dek = generateSymmetricKey();
		const raw = new Uint8Array(randomBytes(CHUNK));
		const base = sealOneChunk(raw, dek, ASSET, 0).ref.hash;
		const other = new Uint8Array(raw);
		other[0] = (other[0] ?? 0) ^ 0x01;
		expect(sealOneChunk(other, dek, ASSET, 0).ref.hash).not.toBe(base); // content
		expect(sealOneChunk(raw, dek, ASSET, 1).ref.hash).not.toBe(base); // position
		expect(sealOneChunk(raw, generateSymmetricKey(), ASSET, 0).ref.hash).not.toBe(base); // key
	});
});

describe("parseAssetChunkManifest (untrusted input)", () => {
	it("accepts a freshly-built manifest and is a round-trip identity", () => {
		const dek = generateSymmetricKey();
		const { manifest } = sealAssetChunks(
			new Uint8Array(randomBytes(2 * CHUNK + 1)),
			dek,
			ASSET,
			CHUNK,
		);
		const parsed = parseAssetChunkManifest(JSON.parse(JSON.stringify(manifest)));
		expect(parsed).toEqual(manifest);
	});

	it("rejects malformed / lying manifests (fail closed → null)", () => {
		const good = sealAssetChunks(
			new Uint8Array(randomBytes(CHUNK)),
			generateSymmetricKey(),
			ASSET,
			CHUNK,
		).manifest;
		expect(parseAssetChunkManifest(null)).toBeNull();
		expect(parseAssetChunkManifest("x")).toBeNull();
		expect(parseAssetChunkManifest([])).toBeNull();
		expect(parseAssetChunkManifest({ ...good, v: 2 })).toBeNull();
		expect(parseAssetChunkManifest({ ...good, assetId: "" })).toBeNull();
		expect(parseAssetChunkManifest({ ...good, chunkBytes: 0 })).toBeNull();
		expect(parseAssetChunkManifest({ ...good, chunks: [] })).toBeNull();
		// A hash that isn't 64-hex.
		expect(
			parseAssetChunkManifest({ ...good, chunks: [{ ...good.chunks[0], hash: "nothex" }] }),
		).toBeNull();
		// totalRawLen that doesn't match the sum of chunk rawLens (over-allocation guard).
		expect(parseAssetChunkManifest({ ...good, totalRawLen: good.totalRawLen + 1000 })).toBeNull();
	});
});

describe("per-asset randomness (OQ-236)", () => {
	it("identical plaintext under different assets yields different addresses", () => {
		const dekA = generateSymmetricKey();
		const dekB = generateSymmetricKey();
		const plain = new Uint8Array(randomBytes(CHUNK));
		const a = sealOneChunk(plain, dekA, "asset-a", 0);
		const b = sealOneChunk(plain, dekB, "asset-b", 0);
		expect(a.ref.hash).not.toBe(b.ref.hash); // no cross-asset/cross-user equality leak
	});
});
