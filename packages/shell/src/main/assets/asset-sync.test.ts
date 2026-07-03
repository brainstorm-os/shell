import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateSymmetricKey } from "../credentials/crypto";
import { MemoryAssetCas } from "./asset-cas";
import type { AssetChunkManifest } from "./asset-chunks";
import { materializeAsset, uploadBoundAsset } from "./asset-sync";

const ENTITY = "ent_blob";
const ASSET = "asset-sync-1";
const CHUNK_DEFAULT = 4 * 1024 * 1024;

/** An in-memory manifest store mirroring the entity Y.Doc's `assetManifests`. */
function manifestStore() {
	const map = new Map<string, AssetChunkManifest>();
	const key = (e: string, a: string) => `${e}\0${a}`;
	return {
		installManifest: async (e: string, a: string, m: AssetChunkManifest) => {
			if (!map.has(key(e, a))) map.set(key(e, a), m);
		},
		readManifest: async (e: string, a: string) => map.get(key(e, a)) ?? null,
		raw: map,
	};
}

describe("uploadBoundAsset → materializeAsset", () => {
	it("round-trips a blob through the node CAS + entity manifest", async () => {
		const dek = generateSymmetricKey();
		const cas = new MemoryAssetCas();
		const store = manifestStore();
		const plain = new Uint8Array(randomBytes(CHUNK_DEFAULT + 1234)); // 2 chunks

		const up = await uploadBoundAsset(
			{ cas, installManifest: store.installManifest },
			ENTITY,
			ASSET,
			"image/png",
			plain,
			dek,
		);
		expect(up.manifest.assetId).toBe(ASSET);
		expect(up.manifest.mime).toBe("image/png");
		expect(up.uploaded).toBe(up.manifest.chunks.length);
		expect(store.raw.size).toBe(1);

		// A paired device with the entity DEK fetches the bytes back.
		const back = await materializeAsset(
			{ cas, readManifest: store.readManifest },
			ENTITY,
			ASSET,
			dek,
		);
		expect(back).not.toBeNull();
		expect(Buffer.from(back?.bytes as Uint8Array).equals(Buffer.from(plain))).toBe(true);
		expect(back?.mime).toBe("image/png");
	});

	it("returns null when the entity carries no manifest for the asset", async () => {
		const cas = new MemoryAssetCas();
		const store = manifestStore();
		const back = await materializeAsset(
			{ cas, readManifest: store.readManifest },
			ENTITY,
			"asset-absent",
			generateSymmetricKey(),
		);
		expect(back).toBeNull();
	});

	it("returns null on a malformed/lying manifest (fail closed)", async () => {
		const cas = new MemoryAssetCas();
		const readManifest = async () => ({ v: 2, assetId: ASSET, chunks: [] });
		const back = await materializeAsset({ cas, readManifest }, ENTITY, ASSET, generateSymmetricKey());
		expect(back).toBeNull();
	});

	it("rejects a manifest whose assetId doesn't match the requested asset", async () => {
		const dek = generateSymmetricKey();
		const cas = new MemoryAssetCas();
		const store = manifestStore();
		await uploadBoundAsset(
			{ cas, installManifest: store.installManifest },
			ENTITY,
			ASSET,
			"image/png",
			new Uint8Array(randomBytes(64)),
			dek,
		);
		// Read the manifest stored under ASSET but ask to materialize a different id.
		const readManifest = async () => store.raw.get(`${ENTITY}\0${ASSET}`) ?? null;
		await expect(materializeAsset({ cas, readManifest }, ENTITY, "other-asset", dek)).rejects.toThrow(
			/assetId/,
		);
	});

	it("propagates a wrong DEK as an open failure (untrusted node)", async () => {
		const dek = generateSymmetricKey();
		const cas = new MemoryAssetCas();
		const store = manifestStore();
		await uploadBoundAsset(
			{ cas, installManifest: store.installManifest },
			ENTITY,
			ASSET,
			"image/png",
			new Uint8Array(randomBytes(64)),
			dek,
		);
		await expect(
			materializeAsset(
				{ cas, readManifest: store.readManifest },
				ENTITY,
				ASSET,
				generateSymmetricKey(),
			),
		).rejects.toThrow();
	});

	it("installs the manifest as idempotent (re-upload doesn't grow the store)", async () => {
		const dek = generateSymmetricKey();
		const cas = new MemoryAssetCas();
		const store = manifestStore();
		const plain = new Uint8Array(randomBytes(2048));
		await uploadBoundAsset(
			{ cas, installManifest: store.installManifest },
			ENTITY,
			ASSET,
			"image/png",
			plain,
			dek,
		);
		const second = await uploadBoundAsset(
			{ cas, installManifest: store.installManifest },
			ENTITY,
			ASSET,
			"image/png",
			plain,
			dek,
		);
		expect(second.skipped).toBe(second.manifest.chunks.length); // all chunks already on node
		expect(store.raw.size).toBe(1);
	});
});
