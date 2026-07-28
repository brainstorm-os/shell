/**
 * Asset-B4 dogfood verbs — the CollabDevBridge asset surface over a REAL
 * `VaultSession` (real encrypted `AssetStore`, real capability ledger) with the
 * production-path deps faked and recorded. The live 2-shell relay-loop proof is
 * `tests/dogfood/collab/011-asset-relay-loop.spec.ts` in the harness repo; this
 * pins the bridge orchestration: mint → grant → entities.update with the
 * `brainstorm://asset/` URL → re-home pass, and the on-access materialise order
 * (evict → reconstruct → local blob, else lazy fetch).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VaultSession } from "../vault/session";
import {
	COLLAB_DEV_APP_ID,
	type CollabAssetBytes,
	type CollabAssetDeps,
	CollabAssetSource,
	CollabDevBridge,
} from "./collab-dev-bridge";

const ENTITY_ID = "ent_asset_bind";
const ENTITY_TYPE = "brainstorm/Note/v1";
const BYTES = new Uint8Array(Array.from({ length: 512 }, (_, i) => (i * 31) % 256));

type UpdateCall = { appId: string; entityId: string; patch: Record<string, unknown> };

describe("CollabDevBridge — Asset-B4 dogfood verbs", () => {
	let dir: string;
	let session: VaultSession;
	let bridge: CollabDevBridge;
	let updates: UpdateCall[];
	let rehomes: number;
	let evicted: string[];
	let reconstructed: string[][];
	let manifestRaw: unknown;
	let materializeResult: CollabAssetBytes | null;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "bs-collab-assets-"));
		session = await VaultSession.create({
			vaultId: "vlt_assets",
			vaultPath: dir,
			forceInsecure: true,
		});
		updates = [];
		rehomes = 0;
		evicted = [];
		reconstructed = [];
		manifestRaw = null;
		materializeResult = null;
		const deps: CollabAssetDeps = {
			updateEntityProperties: async (appId, entityId, patch) => {
				updates.push({ appId, entityId, patch });
				return null;
			},
			readManifest: async () => manifestRaw,
			rehomeAssetDeks: async () => {
				rehomes += 1;
			},
			evictWorkerDoc: async (entityId) => {
				evicted.push(entityId);
			},
			reconstructAssets: async (entityIds) => {
				reconstructed.push([...entityIds]);
			},
			materializeOnAccess: async () => materializeResult,
		};
		bridge = new CollabDevBridge(session, () => null, deps);
		await bridge.provisionEntity(ENTITY_ID, ENTITY_TYPE);
	});

	afterEach(async () => {
		bridge.dispose();
		session.dispose();
		await rm(dir, { recursive: true, force: true });
	});

	it("bindAsset mints an encrypted asset, grants the dev app, routes the bind through the entities service, and runs the re-home pass", async () => {
		const { assetId, url } = await bridge.bindAsset(ENTITY_ID, BYTES, "image/png", "attachment");
		expect(url).toBe(`brainstorm://asset/${assetId}`);

		// The bind rode the REAL entities service path as the dev app.
		expect(updates).toEqual([
			{ appId: COLLAB_DEV_APP_ID, entityId: ENTITY_ID, patch: { attachment: url } },
		]);
		// The type-scoped ledger check the service performs now passes.
		const ledger = await session.capabilityLedger();
		expect(ledger.has(COLLAB_DEV_APP_ID, `entities.write:${ENTITY_TYPE}`)).toBe(true);
		expect(ledger.has(COLLAB_DEV_APP_ID, `entities.read:${ENTITY_TYPE}`)).toBe(true);
		// The re-home pass ran so the entity-doc DEK wrap exists mid-session.
		expect(rehomes).toBe(1);

		// The bytes round-trip from the real encrypted store.
		const local = await bridge.readAssetLocal(assetId);
		expect(local?.mime).toBe("image/png");
		expect(local?.bytes).toEqual(BYTES);
	});

	it("assetStatus reflects the row, the local bytes, and the manifest upload marker", async () => {
		expect(await bridge.assetStatus(ENTITY_ID, "missing-asset")).toEqual({
			hasRow: false,
			hasLocalBytes: false,
			manifestPresent: false,
		});

		const { assetId } = await bridge.bindAsset(ENTITY_ID, BYTES, "image/png", "attachment");
		expect(await bridge.assetStatus(ENTITY_ID, assetId)).toEqual({
			hasRow: true,
			hasLocalBytes: true,
			manifestPresent: false,
		});

		manifestRaw = {
			v: 1,
			assetId,
			mime: "image/png",
			chunkBytes: BYTES.length,
			totalRawLen: BYTES.length,
			chunks: [{ hash: "ab".repeat(32), encLen: BYTES.length + 40, rawLen: BYTES.length }],
		};
		expect((await bridge.assetStatus(ENTITY_ID, assetId)).manifestPresent).toBe(true);
		// A malformed (untrusted) manifest fails closed to absent.
		manifestRaw = { v: 1, assetId };
		expect((await bridge.assetStatus(ENTITY_ID, assetId)).manifestPresent).toBe(false);
	});

	it("materializeAssetOnAccess reconstructs, then serves the LOCAL blob when present", async () => {
		const { assetId } = await bridge.bindAsset(ENTITY_ID, BYTES, "image/png", "attachment");
		const got = await bridge.materializeAssetOnAccess(ENTITY_ID, assetId);
		expect(got?.source).toBe(CollabAssetSource.LocalBlob);
		expect(got?.bytes).toEqual(BYTES);
		expect(got?.mime).toBe("image/png");
		// The worker cache was evicted BEFORE the reconstruction pass read docs.
		expect(evicted).toEqual([ENTITY_ID]);
		expect(reconstructed).toEqual([[ENTITY_ID]]);
	});

	it("materializeAssetOnAccess lazily fetches off the node when the blob is absent", async () => {
		materializeResult = { bytes: BYTES, mime: "image/png" };
		const got = await bridge.materializeAssetOnAccess(ENTITY_ID, "never-seen-asset");
		expect(got?.source).toBe(CollabAssetSource.RelayFetch);
		expect(got?.bytes).toEqual(BYTES);
		// Nothing landed in the local store — the fake fetch doesn't restore.
		expect(await bridge.readAssetLocal("never-seen-asset")).toBeNull();
	});

	it("materializeAssetOnAccess returns null when the asset is nowhere", async () => {
		expect(await bridge.materializeAssetOnAccess(ENTITY_ID, "never-seen-asset")).toBeNull();
	});

	it("asset verbs fail closed when the deps are not wired", async () => {
		const bare = new CollabDevBridge(session, () => null);
		await expect(bare.bindAsset(ENTITY_ID, BYTES, "image/png", "attachment")).rejects.toThrow(
			"asset deps not wired",
		);
		await expect(bare.assetStatus(ENTITY_ID, "x")).rejects.toThrow("asset deps not wired");
		await expect(bare.materializeAssetOnAccess(ENTITY_ID, "x")).rejects.toThrow(
			"asset deps not wired",
		);
		bare.dispose();
	});
});
