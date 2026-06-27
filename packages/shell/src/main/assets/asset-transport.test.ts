import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateSymmetricKey } from "../credentials/crypto";
import { MemoryAssetCas } from "./asset-cas";
import { downloadAsset, isAssetMaterialized, uploadAsset } from "./asset-transport";

const ASSET = "asset-tx-1";
const CHUNK = 16;

describe("uploadAsset → downloadAsset", () => {
	it("round-trips a multi-chunk blob through the CAS", async () => {
		const dek = generateSymmetricKey();
		const cas = new MemoryAssetCas();
		const plain = new Uint8Array(randomBytes(5 * CHUNK + 3));

		const { manifest, uploaded, skipped } = await uploadAsset(plain, dek, ASSET, cas, CHUNK);
		expect(uploaded).toBe(manifest.chunks.length);
		expect(skipped).toBe(0);
		expect(cas.size).toBe(manifest.chunks.length);

		const back = await downloadAsset(manifest, dek, cas);
		expect(Buffer.from(back).equals(Buffer.from(plain))).toBe(true);
	});

	it("round-trips a 0-byte blob (one empty chunk)", async () => {
		const dek = generateSymmetricKey();
		const cas = new MemoryAssetCas();
		const { manifest } = await uploadAsset(new Uint8Array(0), dek, ASSET, cas, CHUNK);
		expect(manifest.chunks.length).toBe(1);
		const back = await downloadAsset(manifest, dek, cas);
		expect(back.length).toBe(0);
	});

	it("skips chunks already on the node (HAS-skip) on a re-upload", async () => {
		const dek = generateSymmetricKey();
		const cas = new MemoryAssetCas();
		const plain = new Uint8Array(randomBytes(4 * CHUNK));
		const first = await uploadAsset(plain, dek, ASSET, cas, CHUNK);
		expect(first.skipped).toBe(0);
		// Re-uploading the identical asset (same id + dek + bytes) re-derives the
		// same addresses, so every chunk is already present → all skipped.
		const second = await uploadAsset(plain, dek, ASSET, cas, CHUNK);
		expect(second.uploaded).toBe(0);
		expect(second.skipped).toBe(second.manifest.chunks.length);
		expect(cas.size).toBe(first.manifest.chunks.length); // no growth
	});
});

describe("integrity against an untrusted node", () => {
	it("throws when the node is missing a chunk", async () => {
		const dek = generateSymmetricKey();
		const cas = new MemoryAssetCas();
		const { manifest } = await uploadAsset(
			new Uint8Array(randomBytes(3 * CHUNK)),
			dek,
			ASSET,
			cas,
			CHUNK,
		);
		const empty = new MemoryAssetCas();
		await expect(downloadAsset(manifest, dek, empty)).rejects.toThrow(/not on node/);
	});

	it("rejects a node that returns wrong bytes for an address", async () => {
		const dek = generateSymmetricKey();
		const cas = new MemoryAssetCas();
		const { manifest } = await uploadAsset(
			new Uint8Array(randomBytes(2 * CHUNK)),
			dek,
			ASSET,
			cas,
			CHUNK,
		);
		// A lying CAS that serves the same (wrong) bytes for every address.
		const liar = {
			has: async () => true,
			put: async () => {},
			get: async () => new Uint8Array(randomBytes(40)),
		};
		await expect(downloadAsset(manifest, dek, liar)).rejects.toThrow(/content-address mismatch/);
	});

	it("rejects the wrong DEK", async () => {
		const dek = generateSymmetricKey();
		const cas = new MemoryAssetCas();
		const { manifest } = await uploadAsset(
			new Uint8Array(randomBytes(CHUNK + 5)),
			dek,
			ASSET,
			cas,
			CHUNK,
		);
		await expect(downloadAsset(manifest, generateSymmetricKey(), cas)).rejects.toThrow();
	});
});

describe("isAssetMaterialized", () => {
	it("is true only when every chunk is present", async () => {
		const dek = generateSymmetricKey();
		const cas = new MemoryAssetCas();
		const { manifest } = await uploadAsset(
			new Uint8Array(randomBytes(3 * CHUNK)),
			dek,
			ASSET,
			cas,
			CHUNK,
		);
		expect(await isAssetMaterialized(manifest, cas)).toBe(true);
		expect(await isAssetMaterialized(manifest, new MemoryAssetCas())).toBe(false);
	});
});
