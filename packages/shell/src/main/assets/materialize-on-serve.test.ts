/**
 * Asset-B4 serve-on-miss — `serveSafeMime` mime downgrade + `materializeAssetOnServe`
 * orchestration (offline short-circuit, per-ref fallthrough, fail-closed on a
 * lying node, best-effort restore, DEK zeroing).
 */

import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { generateSymmetricKey } from "../credentials/crypto";
import type { AssetCas } from "./asset-cas";
import { sealAssetChunks } from "./asset-chunks";
import {
	type MaterializeOnServeDeps,
	materializeAssetOnServe,
	serveSafeMime,
} from "./materialize-on-serve";

const ASSET = "asset-serve-1";
const CHUNK = 16;

/** A Map-backed `AssetCas`; `map` is exposed so a test can tamper a stored chunk. */
function fakeCas(seed?: Map<string, Uint8Array>): { cas: AssetCas; map: Map<string, Uint8Array> } {
	const map = new Map<string, Uint8Array>(seed);
	const cas: AssetCas = {
		has: async (hash) => map.has(hash),
		get: async (hash) => {
			const stored = map.get(hash);
			return stored ? new Uint8Array(stored) : null;
		},
		put: async (hash, chunk) => {
			if (!map.has(hash)) map.set(hash, new Uint8Array(chunk));
		},
	};
	return { cas, map };
}

/** Seal `plain` under a fresh DEK into a fake CAS + a manifest for ASSET. */
function sealedAsset(plain: Uint8Array) {
	const dek = generateSymmetricKey();
	const { manifest, sealed } = sealAssetChunks(plain, dek, ASSET, "image/png", CHUNK);
	return { dek, manifest, ...fakeCas(sealed) };
}

describe("serveSafeMime", () => {
	it("passes safe raster + pdf types through unchanged", () => {
		for (const mime of [
			"image/png",
			"image/jpeg",
			"image/gif",
			"image/webp",
			"image/avif",
			"image/bmp",
			"image/x-icon",
			"image/vnd.microsoft.icon",
			"application/pdf",
		]) {
			expect(serveSafeMime(mime)).toBe(mime);
		}
	});

	it("downgrades script-capable / unknown types to the inert default", () => {
		for (const mime of ["image/svg+xml", "text/html", "application/xml"]) {
			expect(serveSafeMime(mime)).toBe("application/octet-stream");
		}
		expect(serveSafeMime("application/octet-stream")).toBe("application/octet-stream");
	});
});

describe("materializeAssetOnServe", () => {
	it("materialises the bytes, serves the safe mime, and restores the blob once", async () => {
		const plain = new Uint8Array(randomBytes(40)); // 3 chunks at CHUNK=16
		const { dek, manifest, cas } = sealedAsset(plain);
		const restoreBlob = vi.fn(async (_id: string, _bytes: Uint8Array) => undefined);
		const deps: MaterializeOnServeDeps = {
			hasAssetPlane: () => true,
			listRefEntities: () => ["entity-1"],
			recoverDek: async () => new Uint8Array(dek),
			readManifest: async () => manifest,
			cas,
			restoreBlob,
		};

		const got = await materializeAssetOnServe(deps, ASSET);
		expect(got).not.toBeNull();
		expect(Buffer.from(got?.bytes as Uint8Array).equals(Buffer.from(plain))).toBe(true);
		expect(got?.mime).toBe("image/png");
		expect(restoreBlob).toHaveBeenCalledTimes(1);
		expect(restoreBlob.mock.calls[0]?.[0]).toBe(ASSET);
		expect(Buffer.from(restoreBlob.mock.calls[0]?.[1] as Uint8Array).equals(Buffer.from(plain))).toBe(
			true,
		);
	});

	it("returns null offline without touching the refs or DEKs", async () => {
		const listRefEntities = vi.fn(() => ["entity-1"]);
		const recoverDek = vi.fn(async () => generateSymmetricKey());
		const got = await materializeAssetOnServe(
			{
				hasAssetPlane: () => false,
				listRefEntities,
				recoverDek,
				readManifest: async () => null,
				cas: fakeCas().cas,
				restoreBlob: async () => undefined,
			},
			ASSET,
		);
		expect(got).toBeNull();
		expect(listRefEntities).not.toHaveBeenCalled();
		expect(recoverDek).not.toHaveBeenCalled();
	});

	it("returns null when no ref entity yields a DEK, trying every ref", async () => {
		const recoverDek = vi.fn(async () => null);
		const got = await materializeAssetOnServe(
			{
				hasAssetPlane: () => true,
				listRefEntities: () => ["e1", "e2"],
				recoverDek,
				readManifest: async () => null,
				cas: fakeCas().cas,
				restoreBlob: async () => undefined,
			},
			ASSET,
		);
		expect(got).toBeNull();
		expect(recoverDek).toHaveBeenCalledTimes(2);
	});

	it("falls through to the next ref when the first entity's manifest is absent", async () => {
		const plain = new Uint8Array(randomBytes(30));
		const { dek, manifest, cas } = sealedAsset(plain);
		const readManifest = vi.fn(async (entityId: string) => (entityId === "e2" ? manifest : null));
		const got = await materializeAssetOnServe(
			{
				hasAssetPlane: () => true,
				listRefEntities: () => ["e1", "e2"],
				recoverDek: async () => new Uint8Array(dek),
				readManifest,
				cas,
				restoreBlob: async () => undefined,
			},
			ASSET,
		);
		expect(got).not.toBeNull();
		expect(Buffer.from(got?.bytes as Uint8Array).equals(Buffer.from(plain))).toBe(true);
		expect(readManifest).toHaveBeenCalledTimes(2);
	});

	it("fails closed (returns null, no throw) when a stored chunk is tampered", async () => {
		const plain = new Uint8Array(randomBytes(40));
		const { dek, manifest, cas, map } = sealedAsset(plain);
		// Tamper one byte of the first chunk's stored ciphertext — its content
		// address no longer matches the manifest, so the open throws.
		const firstHash = manifest.chunks[0]?.hash as string;
		const stored = map.get(firstHash) as Uint8Array;
		stored[0] = (stored[0] ?? 0) ^ 0xff;
		map.set(firstHash, stored);

		const got = await materializeAssetOnServe(
			{
				hasAssetPlane: () => true,
				listRefEntities: () => ["entity-1"],
				recoverDek: async () => new Uint8Array(dek),
				readManifest: async () => manifest,
				cas,
				restoreBlob: async () => undefined,
			},
			ASSET,
		);
		expect(got).toBeNull();
	});

	it("serves the bytes even when the best-effort blob restore rejects", async () => {
		const plain = new Uint8Array(randomBytes(24));
		const { dek, manifest, cas } = sealedAsset(plain);
		const got = await materializeAssetOnServe(
			{
				hasAssetPlane: () => true,
				listRefEntities: () => ["entity-1"],
				recoverDek: async () => new Uint8Array(dek),
				readManifest: async () => manifest,
				cas,
				restoreBlob: async () => {
					throw new Error("disk full");
				},
			},
			ASSET,
		);
		expect(got).not.toBeNull();
		expect(Buffer.from(got?.bytes as Uint8Array).equals(Buffer.from(plain))).toBe(true);
	});

	it("zeroes the recovered DEK after use", async () => {
		const plain = new Uint8Array(randomBytes(40));
		const { dek, manifest, cas } = sealedAsset(plain);
		await materializeAssetOnServe(
			{
				hasAssetPlane: () => true,
				listRefEntities: () => ["entity-1"],
				recoverDek: async () => dek, // the module zeroes this buffer in finally
				readManifest: async () => manifest,
				cas,
				restoreBlob: async () => undefined,
			},
			ASSET,
		);
		expect(dek.every((b) => b === 0)).toBe(true);
	});
});
