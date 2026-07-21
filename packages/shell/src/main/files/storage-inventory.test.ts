import { StoredAssetKind } from "@brainstorm-os/sdk-types";
import { describe, expect, test } from "vitest";
import { AssetKind } from "../assets/asset-types";
import type { AssetRecord } from "../storage/entities-repo/assets-repo";
import { type FsStoreFile, buildStorageInventory } from "./storage-inventory";

function asset(partial: Partial<AssetRecord> & { assetId: string; byteLen: number }): AssetRecord {
	return {
		dekId: "dek",
		contentHash: "hash",
		mime: "image/png",
		kind: AssetKind.Upload,
		originUrl: null,
		createdAt: 1000,
		boundAt: 2000,
		...partial,
	};
}

function fsFile(partial: Partial<FsStoreFile> & { hash: string; sizeBytes: number }): FsStoreFile {
	return {
		url: `brainstorm://cover/${partial.hash}.png`,
		thumbUrl: null,
		name: `${partial.hash}.png`,
		mime: "image/png",
		uploadedAt: 1000,
		...partial,
	};
}

describe("buildStorageInventory", () => {
	test("aggregates all four storage subsystems", () => {
		const inv = buildStorageInventory({
			assets: [asset({ assetId: "a1", byteLen: 100 })],
			covers: [fsFile({ hash: "c1", sizeBytes: 50 })],
			wallpapers: [fsFile({ hash: "w1", sizeBytes: 200, url: "brainstorm://wallpaper/w1.jpg" })],
			icons: [fsFile({ hash: "i1", sizeBytes: 10, url: "brainstorm://icon/i1.png" })],
		});
		expect(inv.map((a) => a.kind)).toEqual([
			StoredAssetKind.Wallpaper, // 200
			StoredAssetKind.Upload, // 100
			StoredAssetKind.Cover, // 50
			StoredAssetKind.Icon, // 10
		]);
	});

	test("orders largest-first, newest as tiebreak", () => {
		const inv = buildStorageInventory({
			assets: [
				asset({ assetId: "old", byteLen: 100, createdAt: 1 }),
				asset({ assetId: "new", byteLen: 100, createdAt: 9 }),
			],
			covers: [],
			wallpapers: [],
			icons: [],
		});
		expect(inv.map((a) => a.id)).toEqual(["new", "old"]);
	});

	test("maps asset-store kinds and builds resolvable URLs", () => {
		const inv = buildStorageInventory({
			assets: [
				asset({ assetId: "fav1", byteLen: 5, kind: AssetKind.Favicon, mime: "image/x-icon" }),
				asset({ assetId: "cov1", byteLen: 5, kind: AssetKind.Cover }),
			],
			covers: [],
			wallpapers: [],
			icons: [],
		});
		const byId = new Map(inv.map((a) => [a.id, a]));
		expect(byId.get("fav1")?.kind).toBe(StoredAssetKind.Favicon);
		expect(byId.get("cov1")?.kind).toBe(StoredAssetKind.Cover);
		expect(byId.get("fav1")?.url).toBe("brainstorm://asset/fav1");
	});

	test("synthesizes a name with a mime extension for asset blobs", () => {
		const inv = buildStorageInventory({
			assets: [asset({ assetId: "abcdef1234", byteLen: 5, mime: "image/jpeg" })],
			covers: [],
			wallpapers: [],
			icons: [],
		});
		expect(inv[0]?.name).toBe("upload-abcdef12.jpg");
	});

	test("preserves filesystem-store filenames and thumbnails", () => {
		const inv = buildStorageInventory({
			assets: [],
			covers: [
				fsFile({
					hash: "c1",
					sizeBytes: 50,
					name: "c1.webp",
					mime: "image/webp",
					url: "brainstorm://cover/c1.webp",
					thumbUrl: "brainstorm://cover/c1.thumb.jpg",
				}),
			],
			wallpapers: [],
			icons: [],
		});
		expect(inv[0]?.name).toBe("c1.webp");
		expect(inv[0]?.thumbUrl).toBe("brainstorm://cover/c1.thumb.jpg");
	});

	test("returns an empty list when nothing is stored", () => {
		expect(buildStorageInventory({ assets: [], covers: [], wallpapers: [], icons: [] })).toEqual([]);
	});
});
