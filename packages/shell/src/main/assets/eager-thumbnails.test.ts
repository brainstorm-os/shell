/**
 * Asset-B4b — the eager-tier materialise drain: pulls absent thumbnails via
 * the untrusted-node pipeline, per-pair fail-soft, real crypto in the seal /
 * open path (MemoryAssetCas as the node).
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateSymmetricKey } from "../credentials/crypto";
import { MemoryAssetCas } from "./asset-cas";
import { sealAssetChunks } from "./asset-chunks";
import { AssetKind } from "./asset-types";
import { type EagerThumbnailDeps, drainEagerThumbnails } from "./eager-thumbnails";

const ENTITY = "ent-1";
const THUMB = "thumb-1";

function seedNode(bytes: Uint8Array, dek: Uint8Array) {
	const cas = new MemoryAssetCas();
	const { manifest, sealed } = sealAssetChunks(bytes, dek, THUMB, "image/jpeg", 4096, {
		kind: AssetKind.Thumbnail,
		thumbOf: "parent-1",
	});
	for (const [hash, enc] of sealed) void cas.put(hash, enc);
	return { cas, manifest: JSON.parse(JSON.stringify(manifest)) as unknown };
}

function makeDeps(overrides: Partial<EagerThumbnailDeps> = {}): EagerThumbnailDeps & {
	restored: Map<string, Uint8Array>;
} {
	const restored = new Map<string, Uint8Array>();
	const dek = generateSymmetricKey();
	const bytes = new Uint8Array(randomBytes(10_000));
	const { cas, manifest } = seedNode(bytes, dek);
	return {
		restored,
		hasBlob: async (id) => restored.has(id),
		recoverDek: async () => new Uint8Array(dek),
		readManifest: async () => manifest,
		cas,
		restoreBlob: async (id, plaintext) => {
			restored.set(id, plaintext);
		},
		...overrides,
	};
}

const PAIR = [{ entityId: ENTITY, assetId: THUMB }];

describe("drainEagerThumbnails", () => {
	it("materialises an absent thumbnail and is a no-op when already local", async () => {
		const deps = makeDeps();
		const first = await drainEagerThumbnails(deps, PAIR);
		expect(first).toEqual({
			materialized: 1,
			alreadyLocal: 0,
			noDek: 0,
			noManifest: 0,
			failed: 0,
		});
		expect(deps.restored.get(THUMB)?.length).toBe(10_000);
		const second = await drainEagerThumbnails(deps, PAIR);
		expect(second.alreadyLocal).toBe(1);
		expect(second.materialized).toBe(0);
	});

	it("skips a pair with no recoverable DEK (retryable, not fatal)", async () => {
		const deps = makeDeps({ recoverDek: async () => null });
		expect((await drainEagerThumbnails(deps, PAIR)).noDek).toBe(1);
	});

	it("skips a pair whose entity carries no (valid) manifest", async () => {
		const deps = makeDeps({ readManifest: async () => null });
		expect((await drainEagerThumbnails(deps, PAIR)).noManifest).toBe(1);
		// A hostile manifest fails the parse → same outcome, nothing restored.
		const hostile = makeDeps({
			readManifest: async () => ({ v: 1, assetId: THUMB, thumbOf: "../x", chunks: [] }),
		});
		expect((await drainEagerThumbnails(hostile, PAIR)).noManifest).toBe(1);
		expect(hostile.restored.size).toBe(0);
	});

	it("a tampered node chunk fails that pair closed and the drain continues", async () => {
		const deps = makeDeps();
		// Corrupt every stored chunk: content-address check must reject.
		const cas = deps.cas as MemoryAssetCas;
		const tampered = new MemoryAssetCas();
		let count = 0;
		const original = cas.get.bind(cas);
		deps.cas = {
			has: cas.has.bind(cas),
			put: tampered.put.bind(tampered),
			get: async (hash: string) => {
				const enc = await original(hash);
				if (!enc) return null;
				count += 1;
				const bad = new Uint8Array(enc);
				bad[0] = (bad[0] ?? 0) ^ 0xff;
				return bad;
			},
		};
		const tally = await drainEagerThumbnails(deps, [...PAIR, { entityId: ENTITY, assetId: THUMB }]);
		expect(count).toBeGreaterThan(0);
		expect(tally.failed).toBe(2);
		expect(deps.restored.size).toBe(0);
	});
});
