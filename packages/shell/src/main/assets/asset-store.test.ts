/**
 * AssetStore tests — encrypted binary-asset persistence:
 *   - writeAsset → readAsset round-trips bytes + mime.
 *   - encryption at rest: the on-disk `.enc` never contains the plaintext.
 *   - per-asset RANDOM keys: identical bytes → distinct assets AND distinct
 *     ciphertext (the blind-relay equality-leak defense, OQ-236), but a
 *     shared local `content_hash`.
 *   - tamper / wrong-key / file-swap → readAsset throws or returns null.
 *   - bind / orphan-reap lifecycle; delete removes rows (DEK cascades) + blob.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateSymmetricKey } from "../credentials/crypto";
import { DataStores } from "../storage/data-stores";
import { AssetDeksRepository, AssetsRepository } from "../storage/entities-repo";
import { AssetDekStore } from "./asset-dek-store";
import { AssetStore } from "./asset-store";
import { AssetKind } from "./asset-types";

async function setup() {
	const vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-asset-store-"));
	const stores = new DataStores(vaultDir);
	const db = await stores.open("entities");
	const assets = new AssetsRepository(db);
	const deks = new AssetDeksRepository(db);
	const masterKey = generateSymmetricKey();
	const dekStore = new AssetDekStore(deks, masterKey);
	const assetsDir = join(vaultDir, "data", "assets");
	const transaction = (fn: () => void) => db.transaction(fn)();
	const store = new AssetStore(assets, dekStore, assetsDir, transaction);
	return { vaultDir, stores, db, assets, deks, masterKey, dekStore, assetsDir, transaction, store };
}

function blobPath(assetsDir: string, assetId: string): string {
	return join(assetsDir, assetId.slice(0, 2), `${assetId}.enc`);
}

let env: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
	env = await setup();
});
afterEach(async () => {
	env.stores.close();
	await rm(env.vaultDir, { recursive: true, force: true });
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

describe("AssetStore", () => {
	it("round-trips bytes + mime through write/read", async () => {
		const { assetId } = await env.store.writeAsset({
			bytes: PNG,
			mime: "image/png",
			kind: AssetKind.Favicon,
			originUrl: "https://example.com/favicon.ico",
		});
		const got = await env.store.readAsset(assetId);
		if (!got) throw new Error("expected the asset to read back");
		expect(got.bytes).toEqual(PNG);
		expect(got.mime).toBe("image/png");
		const row = env.assets.getById(assetId);
		expect(row?.kind).toBe(AssetKind.Favicon);
		expect(row?.originUrl).toBe("https://example.com/favicon.ico");
		expect(row?.byteLen).toBe(PNG.length);
		expect(row?.boundAt).toBeNull();
	});

	it("never writes the plaintext to disk (encrypted at rest)", async () => {
		const { assetId } = await env.store.writeAsset({
			bytes: PNG,
			mime: "image/png",
			kind: AssetKind.Cover,
		});
		const onDisk = await readFile(blobPath(env.assetsDir, assetId));
		// The plaintext PNG signature must not appear verbatim in the blob.
		expect(Buffer.from(onDisk).includes(Buffer.from(PNG))).toBe(false);
		expect(onDisk.length).toBeGreaterThan(PNG.length); // nonce + tag overhead
	});

	it("gives identical bytes distinct assets + distinct ciphertext, same content_hash", async () => {
		const a = await env.store.writeAsset({ bytes: PNG, mime: "image/png", kind: AssetKind.Favicon });
		const b = await env.store.writeAsset({ bytes: PNG, mime: "image/png", kind: AssetKind.Favicon });
		expect(a.assetId).not.toBe(b.assetId);
		expect(a.contentHash).toBe(b.contentHash); // local dedupe hint
		const blobA = await readFile(blobPath(env.assetsDir, a.assetId));
		const blobB = await readFile(blobPath(env.assetsDir, b.assetId));
		expect(Buffer.from(blobA).equals(Buffer.from(blobB))).toBe(false); // no equality leak
	});

	it("throws when the blob is tampered (AEAD tag)", async () => {
		const { assetId } = await env.store.writeAsset({
			bytes: PNG,
			mime: "image/png",
			kind: AssetKind.Favicon,
		});
		const path = blobPath(env.assetsDir, assetId);
		const blob = await readFile(path);
		const last = blob.length - 1;
		blob[last] = (blob[last] ?? 0) ^ 0xff;
		await writeFile(path, blob);
		await expect(env.store.readAsset(assetId)).rejects.toThrow();
	});

	it("throws under a different master key", async () => {
		const { assetId } = await env.store.writeAsset({
			bytes: PNG,
			mime: "image/png",
			kind: AssetKind.Favicon,
		});
		const otherDekStore = new AssetDekStore(env.deks, generateSymmetricKey());
		const otherStore = new AssetStore(env.assets, otherDekStore, env.assetsDir, env.transaction);
		await expect(otherStore.readAsset(assetId)).rejects.toThrow();
	});

	it("does not decrypt a blob swapped in from another asset (blob AAD binding)", async () => {
		const a = await env.store.writeAsset({ bytes: PNG, mime: "image/png", kind: AssetKind.Favicon });
		const other = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9]);
		const b = await env.store.writeAsset({
			bytes: other,
			mime: "image/png",
			kind: AssetKind.Favicon,
		});
		// Swap A's blob file into B's path; B's DEK + AAD(B) must reject it.
		const blobA = await readFile(blobPath(env.assetsDir, a.assetId));
		await writeFile(blobPath(env.assetsDir, b.assetId), blobA);
		await expect(env.store.readAsset(b.assetId)).rejects.toThrow();
	});

	it("returns null for an unknown asset or a missing blob file", async () => {
		expect(await env.store.readAsset("nope")).toBeNull();
		const { assetId } = await env.store.writeAsset({
			bytes: PNG,
			mime: "image/png",
			kind: AssetKind.Favicon,
		});
		await rm(blobPath(env.assetsDir, assetId));
		expect(await env.store.readAsset(assetId)).toBeNull();
	});

	it("binds an asset so it is no longer reap-eligible; reapOrphans clears the rest", async () => {
		const bound = await env.store.writeAsset({
			bytes: PNG,
			mime: "image/png",
			kind: AssetKind.Favicon,
		});
		const orphan = await env.store.writeAsset({
			bytes: PNG,
			mime: "image/png",
			kind: AssetKind.Cover,
		});
		expect(env.store.markBound(bound.assetId)).toBe(true);
		const reaped = await env.store.reapOrphans(Number.MAX_SAFE_INTEGER);
		expect(reaped).toBe(1);
		expect(env.assets.getById(orphan.assetId)).toBeNull();
		expect(await env.store.readAsset(bound.assetId)).not.toBeNull();
	});

	it("deletes rows (DEK cascades) + unlinks the blob", async () => {
		const { assetId } = await env.store.writeAsset({
			bytes: PNG,
			mime: "image/png",
			kind: AssetKind.Favicon,
		});
		await env.store.deleteAsset(assetId);
		expect(env.assets.getById(assetId)).toBeNull();
		expect(env.deks.getByAssetId(assetId)).toBeNull(); // FK cascade
		await expect(readFile(blobPath(env.assetsDir, assetId))).rejects.toThrow();
	});
});

describe("AssetStore.restoreBlob (serve-on-miss rematerialise)", () => {
	it("re-seals an evicted blob so readAsset round-trips again", async () => {
		const { assetId } = await env.store.writeAsset({
			bytes: PNG,
			mime: "image/png",
			kind: AssetKind.Favicon,
		});
		// Metadata-present, blob-absent: the rows stay, only the `.enc` file is gone.
		await rm(blobPath(env.assetsDir, assetId));
		expect(await env.store.readAsset(assetId)).toBeNull();

		await env.store.restoreBlob(assetId, PNG);
		const got = await env.store.readAsset(assetId);
		if (!got) throw new Error("expected the restored asset to read back");
		expect(got.bytes).toEqual(PNG);
		expect(got.mime).toBe("image/png");
	});

	it("throws when the asset id has no row", async () => {
		await expect(env.store.restoreBlob("nope", PNG)).rejects.toThrow();
	});

	it("throws on a content-hash mismatch (a lying node can't substitute bytes)", async () => {
		const { assetId } = await env.store.writeAsset({
			bytes: PNG,
			mime: "image/png",
			kind: AssetKind.Favicon,
		});
		await rm(blobPath(env.assetsDir, assetId));
		const different = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]);
		await expect(env.store.restoreBlob(assetId, different)).rejects.toThrow();
	});
});
