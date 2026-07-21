import { StoredAssetKind } from "@brainstorm-os/sdk-types";
import { describe, expect, test, vi } from "vitest";
import { AssetKind } from "../assets/asset-types";
import type { AssetRecord } from "../storage/entities-repo";
import { type FsStoreEntry, gatherStorageInventory } from "./gather-storage-inventory";

const upload: AssetRecord = {
	assetId: "a1",
	dekId: "d",
	contentHash: "h",
	mime: "application/pdf",
	byteLen: 5000,
	kind: AssetKind.Upload,
	originUrl: null,
	createdAt: 10,
	boundAt: 20,
};

function entry(name: string, partial?: Partial<FsStoreEntry>): FsStoreEntry {
	return {
		url: `brainstorm://cover/${name}`,
		thumbUrl: null,
		hash: name.split(".")[0] ?? name,
		uploadedAt: 1,
		...partial,
	};
}

describe("gatherStorageInventory", () => {
	test("stats each filesystem file at its store's path and derives mime", async () => {
		const statSize = vi.fn(async (p: string) => (p.includes("covers") ? 300 : 0));
		const inv = await gatherStorageInventory({
			vaultPath: "/vault",
			listBoundAssets: () => [upload],
			liveAssetIds: () => new Set(["a1"]),
			listCovers: async () => [entry("c1.webp")],
			listWallpapers: async () => [],
			listIcons: async () => [],
			statSize,
		});
		expect(statSize).toHaveBeenCalledWith("/vault/covers/c1.webp");
		const cover = inv.find((a) => a.kind === StoredAssetKind.Cover);
		expect(cover?.mime).toBe("image/webp");
		expect(cover?.sizeBytes).toBe(300);
	});

	test("includes bound asset-store uploads alongside fs-store files, largest first", async () => {
		const inv = await gatherStorageInventory({
			vaultPath: "/vault",
			listBoundAssets: () => [upload], // 5000 bytes
			liveAssetIds: () => new Set(["a1"]),
			listCovers: async () => [entry("c1.png")],
			listWallpapers: async () => [
				entry("w1.jpg", { url: "brainstorm://wallpaper/w1.jpg", hash: "w1" }),
			],
			listIcons: async () => [entry("i1.png", { url: "brainstorm://icon/i1.png", hash: "i1" })],
			statSize: async () => 100,
		});
		expect(inv).toHaveLength(4);
		expect(inv[0]?.kind).toBe(StoredAssetKind.Upload); // 5000 > 100
		expect(inv.map((a) => a.kind)).toContain(StoredAssetKind.Wallpaper);
		expect(inv.map((a) => a.kind)).toContain(StoredAssetKind.Icon);
	});

	test("propagates a failed stat as size -1", async () => {
		const inv = await gatherStorageInventory({
			vaultPath: "/vault",
			listBoundAssets: () => [],
			liveAssetIds: () => new Set(),
			listCovers: async () => [entry("c1.png")],
			listWallpapers: async () => [],
			listIcons: async () => [],
			statSize: async () => -1,
		});
		expect(inv[0]?.sizeBytes).toBe(-1);
	});

	test("excludes a bound upload whose owning entity is gone (orphaned blob)", async () => {
		const inv = await gatherStorageInventory({
			vaultPath: "/vault",
			listBoundAssets: () => [upload], // a1
			liveAssetIds: () => new Set(), // no live entity references a1
			listCovers: async () => [],
			listWallpapers: async () => [],
			listIcons: async () => [],
			statSize: async () => 100,
		});
		expect(inv.map((a) => a.kind)).not.toContain(StoredAssetKind.Upload);
	});
});
