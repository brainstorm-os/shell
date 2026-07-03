/**
 * Asset-B5 — metadata reconstruction from synced manifests (the cold-first-
 * fetch rung): valid manifests mint rows + refs, `kind` degrades to `upload`,
 * bad manifests / missing wraps are skipped per-pair, present rows only ensure
 * the ref, and one throwing pair never aborts the pass.
 */

import { describe, expect, it } from "vitest";
import { sealAssetChunks } from "./asset-chunks";
import { AssetKind, AssetRefRole } from "./asset-types";
import { type ReconstructDeps, reconstructAssetMetadata } from "./reconstruct-assets";

const DEK = () => new Uint8Array(32).fill(7);

function manifestFor(assetId: string, kind?: AssetKind): unknown {
	const bytes = new Uint8Array([1, 2, 3, 4]);
	const { manifest } = sealAssetChunks(bytes, DEK(), assetId, "image/png", undefined, kind);
	return JSON.parse(JSON.stringify(manifest));
}

type Fake = {
	deps: ReconstructDeps;
	registered: Array<{ assetId: string; kind: AssetKind; byteLen: number; mime: string }>;
	refs: Array<{ entityId: string; assetId: string; role: AssetRefRole }>;
};

function fake(overrides: Partial<ReconstructDeps> = {}): Fake {
	const registered: Fake["registered"] = [];
	const refs: Fake["refs"] = [];
	const deps: ReconstructDeps = {
		listManifests: async () => [],
		hasAsset: (id) => registered.some((r) => r.assetId === id),
		recoverDek: async () => DEK(),
		registerSynced: (input) => {
			registered.push({
				assetId: input.assetId,
				kind: input.kind,
				byteLen: input.byteLen,
				mime: input.mime,
			});
			return true;
		},
		hasRef: (e, a) => refs.some((r) => r.entityId === e && r.assetId === a),
		createRef: (entityId, assetId, role) => {
			refs.push({ entityId, assetId, role });
		},
		...overrides,
	};
	return { deps, registered, refs };
}

describe("reconstructAssetMetadata", () => {
	it("mints row + DEK cache + ref from a valid manifest, role from the manifest kind", async () => {
		const f = fake({
			listManifests: async () => [{ assetId: "a1", manifest: manifestFor("a1", AssetKind.Cover) }],
		});
		const tally = await reconstructAssetMetadata(f.deps, ["ent-1"]);
		expect(tally).toEqual({ created: 1, present: 0, badManifest: 0, noDek: 0, failed: 0 });
		expect(f.registered).toEqual([
			{ assetId: "a1", kind: AssetKind.Cover, byteLen: 4, mime: "image/png" },
		]);
		expect(f.refs).toEqual([{ entityId: "ent-1", assetId: "a1", role: AssetRefRole.Cover }]);
	});

	it("a manifest without kind degrades to upload/inline", async () => {
		const f = fake({
			listManifests: async () => [{ assetId: "a1", manifest: manifestFor("a1") }],
		});
		await reconstructAssetMetadata(f.deps, ["ent-1"]);
		expect(f.registered[0]?.kind).toBe(AssetKind.Upload);
		expect(f.refs[0]?.role).toBe(AssetRefRole.Inline);
	});

	it("zeroes the recovered DEK after registering", async () => {
		const dek = DEK();
		const f = fake({
			listManifests: async () => [{ assetId: "a1", manifest: manifestFor("a1") }],
			recoverDek: async () => dek,
		});
		await reconstructAssetMetadata(f.deps, ["ent-1"]);
		expect(dek.every((b) => b === 0)).toBe(true);
	});

	it("skips a bad manifest and an id-mismatched manifest", async () => {
		const f = fake({
			listManifests: async () => [
				{ assetId: "a1", manifest: { v: 1, garbage: true } },
				{ assetId: "a2", manifest: manifestFor("SOMEONE-ELSE") },
			],
		});
		const tally = await reconstructAssetMetadata(f.deps, ["ent-1"]);
		expect(tally.badManifest).toBe(2);
		expect(f.registered).toHaveLength(0);
		expect(f.refs).toHaveLength(0);
	});

	it("skips (retryable) when no DEK wrap is recoverable", async () => {
		const f = fake({
			listManifests: async () => [{ assetId: "a1", manifest: manifestFor("a1") }],
			recoverDek: async () => null,
		});
		const tally = await reconstructAssetMetadata(f.deps, ["ent-1"]);
		expect(tally.noDek).toBe(1);
		expect(f.registered).toHaveLength(0);
	});

	it("a present row only ensures the ref (idempotent re-run)", async () => {
		const f = fake({
			listManifests: async () => [{ assetId: "a1", manifest: manifestFor("a1", AssetKind.Favicon) }],
		});
		await reconstructAssetMetadata(f.deps, ["ent-1"]);
		const tally = await reconstructAssetMetadata(f.deps, ["ent-1"]);
		expect(tally).toEqual({ created: 0, present: 1, badManifest: 0, noDek: 0, failed: 0 });
		expect(f.registered).toHaveLength(1);
		expect(f.refs).toHaveLength(1);
	});

	it("one throwing pair is tallied failed and never aborts the rest", async () => {
		const f = fake({
			listManifests: async (entityId) =>
				entityId === "ent-bad"
					? [{ assetId: "boom", manifest: manifestFor("boom") }]
					: [{ assetId: "a1", manifest: manifestFor("a1") }],
			recoverDek: async (_e, assetId) => {
				if (assetId === "boom") throw new Error("wrap explode");
				return DEK();
			},
		});
		const tally = await reconstructAssetMetadata(f.deps, ["ent-bad", "ent-1"]);
		expect(tally.failed).toBe(1);
		expect(tally.created).toBe(1);
		expect(f.registered.map((r) => r.assetId)).toEqual(["a1"]);
	});

	it("a listManifests failure for one entity is contained", async () => {
		const f = fake({
			listManifests: async (entityId) => {
				if (entityId === "ent-bad") throw new Error("worker gone");
				return [{ assetId: "a1", manifest: manifestFor("a1") }];
			},
		});
		const tally = await reconstructAssetMetadata(f.deps, ["ent-bad", "ent-1"]);
		expect(tally.failed).toBe(1);
		expect(tally.created).toBe(1);
	});
});
