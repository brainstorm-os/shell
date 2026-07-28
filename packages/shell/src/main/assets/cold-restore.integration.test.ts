/**
 * Asset-B5 end-to-end — the cold-first-fetch path with REAL crypto and real
 * SQLite rows, faking only the transports (in-memory CAS as the durable node,
 * plain maps as the entity Y.Doc's manifest/wrap planes):
 *
 *   device A (owner):  writeAsset → re-home wrap → uploadBoundAsset
 *   device B (cold):   reconstructAssetMetadata → rows exist, no blob
 *                      → materializeAssetOnServe → bytes + hash backfill
 *                      → second read serves straight from the local blob file
 *
 * Device B has its OWN master key and an EMPTY entities.db — everything it
 * learns arrives through the manifest, the re-homed wrap (opened under the
 * shared entity DEK), and the node CAS. This is the exact restore-from-zero
 * shape 10.14 leaves behind after the Y.Doc backfill.
 */

import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sealAssetDekUnderEntity } from "../credentials/asset-dek-wrap";
import { generateSymmetricKey } from "../credentials/crypto";
import type { EntityDekStore } from "../entities/entity-dek-store";
import { DataStores } from "../storage/data-stores";
import {
	AssetDeksRepository,
	AssetRefsRepository,
	AssetsRepository,
	EntitiesRepository,
} from "../storage/entities-repo";
import { MemoryAssetCas } from "./asset-cas";
import { AssetDekStore } from "./asset-dek-store";
import { AssetStore } from "./asset-store";
import { uploadBoundAsset } from "./asset-sync";
import { AssetKind, AssetRefRole } from "./asset-types";
import { drainEagerThumbnails } from "./eager-thumbnails";
import { materializeAssetOnServe } from "./materialize-on-serve";
import { reconstructAssetMetadata } from "./reconstruct-assets";
import { recoverAssetDek } from "./recover-asset-dek";

const ENTITY = "ent_cold";
const ASSET = "asset-cold-1";

async function coldDevice() {
	const vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-cold-b5-"));
	const stores = new DataStores(vaultDir);
	const db = await stores.open("entities");
	const assets = new AssetsRepository(db);
	const refs = new AssetRefsRepository(db);
	const dekStore = new AssetDekStore(new AssetDeksRepository(db), generateSymmetricKey());
	const store = new AssetStore(assets, dekStore, join(vaultDir, "data", "assets"), (fn) =>
		db.transaction(fn)(),
	);
	// The 10.14 backfill materialises the entity row BEFORE the asset pass runs
	// (`asset_refs.entity_id` FK) — mirror that precondition here.
	new EntitiesRepository(db).create({
		id: ENTITY,
		type: "io.x/File/v1",
		properties: {},
		createdBy: "device-b",
		now: 900,
		dekId: null,
	});
	return { vaultDir, stores, db, assets, refs, dekStore, store };
}

function fakeEntityDekStore(entityDeks: Map<string, Uint8Array>): EntityDekStore {
	return {
		open: (id: string) => {
			const dek = entityDeks.get(id);
			return dek ? { dek: new Uint8Array(dek) } : null;
		},
		close: (dek: Uint8Array) => dek.fill(0),
	} as unknown as EntityDekStore;
}

let cold: Awaited<ReturnType<typeof coldDevice>>;
beforeEach(async () => {
	cold = await coldDevice();
});
afterEach(async () => {
	cold.stores.close();
	await rm(cold.vaultDir, { recursive: true, force: true });
});

describe("Asset-B5 cold restore end-to-end", () => {
	it("owner upload → cold reconstruct → lazy materialise → local round-trip", async () => {
		// ── The shared planes ────────────────────────────────────────────
		const node = new MemoryAssetCas(); // the durable node's CAS
		const manifests = new Map<string, unknown>(); // entity Y.Doc: assetManifests
		const entityDek = generateSymmetricKey(); // synced to both devices (10.x wraps)

		// ── Device A (owner) ─────────────────────────────────────────────
		const plaintext = new Uint8Array(randomBytes(3 * 1024 + 7));
		const assetDek = generateSymmetricKey();
		// B1 — the re-homed wrap rides the entity Y.Doc.
		const wrap = sealAssetDekUnderEntity(assetDek, entityDek, ENTITY, ASSET);
		// B4 — chunks to the node, manifest onto the entity (kind included, B5).
		await uploadBoundAsset(
			{
				cas: node,
				installManifest: async (_e, assetId, manifest) => {
					manifests.set(assetId, JSON.parse(JSON.stringify(manifest)));
				},
			},
			ENTITY,
			ASSET,
			"image/png",
			plaintext,
			assetDek,
			{ kind: AssetKind.Cover },
		);
		assetDek.fill(0); // device A is gone from here on

		// ── Device B (cold): the metadata plane arrived via Y.Doc backfill ──
		const entityDekStore = fakeEntityDekStore(new Map([[ENTITY, entityDek]]));
		const recoverDek = (entityId: string, assetId: string) =>
			recoverAssetDek(
				{
					assetDekStore: cold.dekStore,
					entityDekStore,
					readAssetDekWrap: async (_e, a) => (a === ASSET ? wrap : null),
				},
				entityId,
				assetId,
			);

		const tally = await reconstructAssetMetadata(
			{
				listManifests: async (entityId) =>
					entityId === ENTITY
						? [...manifests.entries()].map(([assetId, manifest]) => ({ assetId, manifest }))
						: [],
				hasAsset: (id) => cold.assets.getById(id) !== null,
				recoverDek,
				registerSynced: (input) => cold.store.registerSynced(input),
				hasRef: (entityId, assetId) =>
					cold.refs.listByEntity(entityId).some((r) => r.assetId === assetId),
				createRef: (entityId, assetId, role) =>
					cold.refs.create({ entityId, assetId, role, now: 1000 }),
			},
			[ENTITY],
		);
		expect(tally).toEqual({ created: 1, present: 0, badManifest: 0, noDek: 0, failed: 0 });

		// Metadata-present, blob-absent: the row is faithful, bytes still remote.
		const row = cold.assets.getById(ASSET);
		expect(row?.kind).toBe(AssetKind.Cover);
		expect(row?.byteLen).toBe(plaintext.length);
		expect(row?.contentHash).toBe("");
		expect(await cold.store.readAsset(ASSET)).toBeNull();

		// ── Lazy materialise on first serve (B4 serve-on-miss, unchanged) ──
		const served = await materializeAssetOnServe(
			{
				hasAssetPlane: () => true,
				listRefEntities: (assetId) => cold.refs.listByAsset(assetId).map((r) => r.entityId),
				recoverDek,
				readManifest: async (_e, assetId) => manifests.get(assetId) ?? null,
				cas: node,
				restoreBlob: (id, bytes) => cold.store.restoreBlob(id, bytes),
			},
			ASSET,
		);
		if (!served) throw new Error("expected the cold device to materialise the asset");
		expect(Buffer.from(served.bytes).equals(Buffer.from(plaintext))).toBe(true);
		expect(served.mime).toBe("image/png");

		// The hash backfilled and the blob file landed: the next read is local.
		expect(cold.assets.getById(ASSET)?.contentHash).not.toBe("");
		const local = await cold.store.readAsset(ASSET);
		if (!local) throw new Error("expected a local read after materialise");
		expect(Buffer.from(local.bytes).equals(Buffer.from(plaintext))).toBe(true);
	});

	it("Asset-B4b: cold reconstruct links the thumb and the eager drain materialises ONLY it", async () => {
		const THUMB = "asset-cold-1-thumb";
		const node = new MemoryAssetCas();
		const manifests = new Map<string, unknown>();
		const entityDek = generateSymmetricKey();

		// ── Device A (owner): full blob + derived thumbnail, two assets ────
		const fullBytes = new Uint8Array(randomBytes(40 * 1024));
		const thumbBytes = new Uint8Array(randomBytes(3 * 1024));
		const fullDek = generateSymmetricKey();
		const thumbDek = generateSymmetricKey();
		const fullWrap = sealAssetDekUnderEntity(fullDek, entityDek, ENTITY, ASSET);
		const thumbWrap = sealAssetDekUnderEntity(thumbDek, entityDek, ENTITY, THUMB);
		const installManifest = async (_e: string, assetId: string, manifest: unknown) => {
			manifests.set(assetId, JSON.parse(JSON.stringify(manifest)));
		};
		await uploadBoundAsset(
			{ cas: node, installManifest },
			ENTITY,
			ASSET,
			"image/jpeg",
			fullBytes,
			fullDek,
			{ kind: AssetKind.Upload },
		);
		await uploadBoundAsset(
			{ cas: node, installManifest },
			ENTITY,
			THUMB,
			"image/jpeg",
			thumbBytes,
			thumbDek,
			{ kind: AssetKind.Thumbnail, thumbOf: ASSET },
		);
		fullDek.fill(0);
		thumbDek.fill(0);

		// ── Device B (cold) ────────────────────────────────────────────────
		const entityDekStore = fakeEntityDekStore(new Map([[ENTITY, entityDek]]));
		const recoverDek = (entityId: string, assetId: string) =>
			recoverAssetDek(
				{
					assetDekStore: cold.dekStore,
					entityDekStore,
					readAssetDekWrap: async (_e, a) => (a === ASSET ? fullWrap : a === THUMB ? thumbWrap : null),
				},
				entityId,
				assetId,
			);

		const tally = await reconstructAssetMetadata(
			{
				listManifests: async (entityId) =>
					entityId === ENTITY
						? [...manifests.entries()].map(([assetId, manifest]) => ({ assetId, manifest }))
						: [],
				hasAsset: (id) => cold.assets.getById(id) !== null,
				recoverDek,
				registerSynced: (input) => cold.store.registerSynced(input),
				hasRef: (entityId, assetId) =>
					cold.refs.listByEntity(entityId).some((r) => r.assetId === assetId),
				createRef: (entityId, assetId, role) =>
					cold.refs.create({ entityId, assetId, role, now: 1000 }),
				linkThumb: (parentId, thumbId) => {
					cold.assets.setThumbAssetIfUnset(parentId, thumbId);
				},
			},
			[ENTITY],
		);
		expect(tally.created).toBe(2);

		// Rows faithful: kinds, roles, and the parent → thumb link.
		expect(cold.assets.getById(ASSET)?.kind).toBe(AssetKind.Upload);
		expect(cold.assets.getById(THUMB)?.kind).toBe(AssetKind.Thumbnail);
		expect(cold.assets.getById(ASSET)?.thumbAssetId).toBe(THUMB);
		expect(cold.refs.listByEntity(ENTITY).find((r) => r.assetId === THUMB)?.role).toBe(
			AssetRefRole.Thumbnail,
		);

		// ── The eager tier: thumbnails materialise proactively ─────────────
		const eagerTally = await drainEagerThumbnails(
			{
				hasBlob: (id) => cold.store.hasBlob(id),
				recoverDek,
				readManifest: async (_e, assetId) => manifests.get(assetId) ?? null,
				cas: node,
				restoreBlob: (id, bytes) => cold.store.restoreBlob(id, bytes),
			},
			cold.refs.listPairsByRole(AssetRefRole.Thumbnail),
		);
		expect(eagerTally).toEqual({
			materialized: 1,
			alreadyLocal: 0,
			noDek: 0,
			noManifest: 0,
			failed: 0,
		});

		// The thumb is local (round-trips through the store); the FULL blob is
		// still absent — lazy until first access, exactly as before B4b.
		expect(await cold.store.hasBlob(THUMB)).toBe(true);
		const thumbLocal = await cold.store.readAsset(THUMB);
		expect(thumbLocal && Buffer.from(thumbLocal.bytes).equals(Buffer.from(thumbBytes))).toBe(true);
		expect(await cold.store.hasBlob(ASSET)).toBe(false);
		expect(await cold.store.readAsset(ASSET)).toBeNull();

		// A second drain pass is a no-op (already local).
		const second = await drainEagerThumbnails(
			{
				hasBlob: (id) => cold.store.hasBlob(id),
				recoverDek,
				readManifest: async (_e, assetId) => manifests.get(assetId) ?? null,
				cas: node,
				restoreBlob: (id, bytes) => cold.store.restoreBlob(id, bytes),
			},
			cold.refs.listPairsByRole(AssetRefRole.Thumbnail),
		);
		expect(second.alreadyLocal).toBe(1);
		expect(second.materialized).toBe(0);
	});

	it("reconstruction is inert for an entity whose wrap this device cannot open", async () => {
		const node = new MemoryAssetCas();
		const manifests = new Map<string, unknown>();
		const assetDek = generateSymmetricKey();
		// Wrap under an entity DEK device B does NOT hold (unshared entity).
		const wrap = sealAssetDekUnderEntity(assetDek, generateSymmetricKey(), ENTITY, ASSET);
		await uploadBoundAsset(
			{
				cas: node,
				installManifest: async (_e, assetId, manifest) => {
					manifests.set(assetId, JSON.parse(JSON.stringify(manifest)));
				},
			},
			ENTITY,
			ASSET,
			"image/png",
			new Uint8Array([1, 2, 3]),
			assetDek,
		);

		const tally = await reconstructAssetMetadata(
			{
				listManifests: async () =>
					[...manifests.entries()].map(([assetId, manifest]) => ({ assetId, manifest })),
				hasAsset: (id) => cold.assets.getById(id) !== null,
				recoverDek: (entityId, assetId) =>
					recoverAssetDek(
						{
							assetDekStore: cold.dekStore,
							entityDekStore: fakeEntityDekStore(new Map()),
							readAssetDekWrap: async () => wrap,
						},
						entityId,
						assetId,
					),
				registerSynced: (input) => cold.store.registerSynced(input),
				hasRef: () => false,
				createRef: () => {
					throw new Error("must not bind a ref without a recoverable DEK");
				},
			},
			[ENTITY],
		);
		expect(tally.noDek).toBe(1);
		expect(cold.assets.getById(ASSET)).toBeNull();
	});
});
