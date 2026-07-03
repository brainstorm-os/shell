/**
 * Asset-B4 upload-on-bind — `uploadBoundAssetIfPending` outcome classification
 * (present manifest short-circuit, not-local, no-dek, uploaded) + DEK zeroing,
 * and `drainPendingUploads` per-pair isolation over a mixed batch.
 */

import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { generateSymmetricKey } from "../credentials/crypto";
import type { AssetCas } from "./asset-cas";
import type { AssetChunkManifest } from "./asset-chunks";
import {
	UploadBoundOutcome,
	type UploadOnBindDeps,
	drainPendingUploads,
	uploadBoundAssetIfPending,
} from "./upload-on-bind";

const ENTITY = "ent-1";
const ASSET = "asset-upload-1";

function fakeCas(): { cas: AssetCas; puts: string[] } {
	const map = new Map<string, Uint8Array>();
	const puts: string[] = [];
	const cas: AssetCas = {
		has: async (hash) => map.has(hash),
		get: async (hash) => {
			const stored = map.get(hash);
			return stored ? new Uint8Array(stored) : null;
		},
		put: async (hash, chunk) => {
			puts.push(hash);
			if (!map.has(hash)) map.set(hash, new Uint8Array(chunk));
		},
	};
	return { cas, puts };
}

describe("uploadBoundAssetIfPending", () => {
	it("short-circuits AlreadyPresent without reading the asset", async () => {
		const readAsset = vi.fn(async () => ({ bytes: new Uint8Array([1]), mime: "image/png" }));
		const outcome = await uploadBoundAssetIfPending(
			{
				cas: fakeCas().cas,
				installManifest: vi.fn(async () => undefined),
				manifestPresent: async () => true,
				readAsset,
				recoverDek: async () => generateSymmetricKey(),
			},
			ENTITY,
			ASSET,
		);
		expect(outcome).toBe(UploadBoundOutcome.AlreadyPresent);
		expect(readAsset).not.toHaveBeenCalled();
	});

	it("returns NotLocal when the blob isn't on this device", async () => {
		const outcome = await uploadBoundAssetIfPending(
			{
				cas: fakeCas().cas,
				installManifest: vi.fn(async () => undefined),
				manifestPresent: async () => false,
				readAsset: async () => null,
				recoverDek: async () => generateSymmetricKey(),
			},
			ENTITY,
			ASSET,
		);
		expect(outcome).toBe(UploadBoundOutcome.NotLocal);
	});

	it("returns NoDek when the per-asset DEK can't be recovered", async () => {
		const outcome = await uploadBoundAssetIfPending(
			{
				cas: fakeCas().cas,
				installManifest: vi.fn(async () => undefined),
				manifestPresent: async () => false,
				readAsset: async () => ({ bytes: new Uint8Array(randomBytes(16)), mime: "image/png" }),
				recoverDek: async () => null,
			},
			ENTITY,
			ASSET,
		);
		expect(outcome).toBe(UploadBoundOutcome.NoDek);
	});

	it("uploads the chunks + installs a matching manifest on the happy path", async () => {
		const { cas, puts } = fakeCas();
		const bytes = new Uint8Array(randomBytes(48));
		const installManifest = vi.fn(
			async (_entityId: string, _assetId: string, _manifest: AssetChunkManifest) => undefined,
		);
		const dek = generateSymmetricKey();
		const outcome = await uploadBoundAssetIfPending(
			{
				cas,
				installManifest,
				manifestPresent: async () => false,
				readAsset: async () => ({ bytes, mime: "image/webp" }),
				recoverDek: async () => new Uint8Array(dek),
			},
			ENTITY,
			ASSET,
		);
		expect(outcome).toBe(UploadBoundOutcome.Uploaded);
		expect(puts.length).toBeGreaterThan(0);
		expect(installManifest).toHaveBeenCalledTimes(1);
		const manifest = installManifest.mock.calls[0]?.[2] as AssetChunkManifest;
		expect(manifest.mime).toBe("image/webp");
		expect(manifest.assetId).toBe(ASSET);
	});

	it("zeroes the recovered DEK after an Uploaded", async () => {
		const dek = generateSymmetricKey();
		await uploadBoundAssetIfPending(
			{
				cas: fakeCas().cas,
				installManifest: vi.fn(async () => undefined),
				manifestPresent: async () => false,
				readAsset: async () => ({ bytes: new Uint8Array(randomBytes(16)), mime: "image/png" }),
				recoverDek: async () => dek, // the module zeroes this buffer in finally
			},
			ENTITY,
			ASSET,
		);
		expect(dek.every((b) => b === 0)).toBe(true);
	});
});

describe("drainPendingUploads", () => {
	it("tallies every outcome and isolates a throwing pair", async () => {
		const { cas } = fakeCas();
		const dek = generateSymmetricKey();
		const deps: UploadOnBindDeps = {
			cas,
			installManifest: vi.fn(async () => undefined),
			manifestPresent: async (_e, a) => a === "a_present",
			readAsset: async (a) =>
				a === "a_notlocal" ? null : { bytes: new Uint8Array(randomBytes(16)), mime: "image/png" },
			recoverDek: async (_e, a) => {
				if (a === "a_throw") throw new Error("recover blew up");
				if (a === "a_nodek") return null;
				return new Uint8Array(dek);
			},
		};
		const pairs = [
			{ entityId: ENTITY, assetId: "a_present" },
			{ entityId: ENTITY, assetId: "a_notlocal" },
			{ entityId: ENTITY, assetId: "a_nodek" },
			{ entityId: ENTITY, assetId: "a_throw" },
			{ entityId: ENTITY, assetId: "a_uploaded" }, // after the throw — must still run
		];

		const tally = await drainPendingUploads(deps, pairs);
		expect(tally).toEqual({
			uploaded: 1,
			alreadyPresent: 1,
			notLocal: 1,
			noDek: 1,
			failed: 1,
		});
	});
});
