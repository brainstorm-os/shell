/**
 * Asset-B4 — `AssetRefsRepository.deleteRef`: removes exactly one (entity,
 * asset) binding across its role rows, leaving sibling refs (and their
 * `created_at`) intact.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AssetKind, AssetRefRole } from "../../assets/asset-types";
import { DataStores } from "../data-stores";
import { AssetRefsRepository } from "./asset-refs-repo";
import { AssetsRepository } from "./assets-repo";
import { EntitiesRepository } from "./entities-repo";

async function setup() {
	const vaultDir = await mkdtemp(join(tmpdir(), "brainstorm-asset-refs-"));
	const stores = new DataStores(vaultDir);
	const db = await stores.open("entities");
	const entities = new EntitiesRepository(db);
	const assets = new AssetsRepository(db);
	const refs = new AssetRefsRepository(db);
	entities.create({
		id: "ent_owner",
		type: "io.x/Bookmark/v1",
		properties: {},
		createdBy: "io.x",
		now: 100,
		dekId: null,
	});
	for (const [assetId, kind] of [
		["asset_a", AssetKind.Favicon],
		["asset_b", AssetKind.Cover],
	] as const) {
		assets.create({
			assetId,
			dekId: `dek_${assetId}`,
			contentHash: `hash_${assetId}`,
			mime: "image/png",
			byteLen: 10,
			kind,
			now: 100,
		});
	}
	return { vaultDir, stores, entities, assets, refs };
}

describe("AssetRefsRepository.deleteRef", () => {
	let e: Awaited<ReturnType<typeof setup>>;
	beforeEach(async () => {
		e = await setup();
	});
	afterEach(async () => {
		e.stores.close();
		await rm(e.vaultDir, { recursive: true, force: true }).catch(() => {});
	});

	it("removes exactly the named (entity, asset) pair and leaves siblings", () => {
		e.refs.create({ entityId: "ent_owner", assetId: "asset_a", role: AssetRefRole.Favicon, now: 1 });
		e.refs.create({ entityId: "ent_owner", assetId: "asset_b", role: AssetRefRole.Cover, now: 2 });

		e.refs.deleteRef("ent_owner", "asset_a");

		const remaining = e.refs.listByEntity("ent_owner");
		expect(remaining.map((r) => r.assetId)).toEqual(["asset_b"]);
		// The sibling kept its original created_at (not rewritten).
		expect(remaining[0]?.createdAt).toBe(2);
		expect(e.refs.countByAsset("asset_a")).toBe(0);
		expect(e.refs.countByAsset("asset_b")).toBe(1);
	});

	it("is a no-op when the pair is absent", () => {
		e.refs.create({ entityId: "ent_owner", assetId: "asset_b", role: AssetRefRole.Cover, now: 2 });
		e.refs.deleteRef("ent_owner", "asset_a");
		expect(e.refs.listByEntity("ent_owner")).toHaveLength(1);
	});
});
