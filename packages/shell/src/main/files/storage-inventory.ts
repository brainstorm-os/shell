/**
 * buildStorageInventory — normalize every storage subsystem into one
 * `StoredAsset[]` for the Files "Storage" view.
 *
 * The vault stores bytes in two shapes: the encrypted **asset store**
 * (`brainstorm://asset/<id>` — file uploads, scraped covers/favicons,
 * inline images) and three content-addressed **filesystem stores** for
 * covers / wallpapers / icons (`brainstorm://cover|wallpaper|icon/<hash>`).
 * They never shared a list surface, so "what's taking up disk" had no home.
 * This pure function unifies them, largest-first, so the Files app can
 * answer that question without knowing each store's internals.
 *
 * Kept side-effect-free (no fs, no db) so the normalization + ordering is
 * unit-tested without a live vault; the service layer fetches each list and
 * stats sizes, then hands the rows here.
 */

import { type StoredAsset, StoredAssetKind } from "@brainstorm-os/sdk-types";
import { AssetKind } from "../assets/asset-types";
import type { AssetRecord } from "../storage/entities-repo/assets-repo";

/** A content-addressed filesystem-store entry (cover / wallpaper / icon),
 *  size already stat-ed by the service. */
export type FsStoreFile = {
	/** Content hash (the store's primary key). */
	readonly hash: string;
	readonly url: string;
	readonly thumbUrl: string | null;
	/** Filename including extension, e.g. `<hash>.png`. */
	readonly name: string;
	readonly mime: string;
	/** Bytes on disk; `-1` when the stat failed. */
	readonly sizeBytes: number;
	readonly uploadedAt: number;
};

export type StorageInventoryInput = {
	readonly assets: readonly AssetRecord[];
	readonly covers: readonly FsStoreFile[];
	readonly wallpapers: readonly FsStoreFile[];
	readonly icons: readonly FsStoreFile[];
};

const ASSET_KIND_TO_STORED: Record<AssetKind, StoredAssetKind> = {
	[AssetKind.Upload]: StoredAssetKind.Upload,
	[AssetKind.Cover]: StoredAssetKind.Cover,
	[AssetKind.Favicon]: StoredAssetKind.Favicon,
};

const MIME_EXT: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/webp": ".webp",
	"image/gif": ".gif",
	"image/avif": ".avif",
	"image/svg+xml": ".svg",
	"application/pdf": ".pdf",
};

function extForMime(mime: string): string {
	return MIME_EXT[mime] ?? "";
}

/** Asset-store blobs carry no filename (the owning `File/v1` entity does),
 *  so synthesize a stable, human one from kind + a short hash + mime ext. */
function nameForAsset(asset: AssetRecord): string {
	return `${asset.kind}-${asset.assetId.slice(0, 8)}${extForMime(asset.mime)}`;
}

export function buildStorageInventory(input: StorageInventoryInput): StoredAsset[] {
	const out: StoredAsset[] = [];

	for (const asset of input.assets) {
		out.push({
			id: asset.assetId,
			kind: ASSET_KIND_TO_STORED[asset.kind] ?? StoredAssetKind.Upload,
			name: nameForAsset(asset),
			mime: asset.mime,
			sizeBytes: asset.byteLen,
			url: `brainstorm://asset/${asset.assetId}`,
			thumbUrl: null,
			createdAt: asset.createdAt,
		});
	}

	pushFsFiles(out, input.covers, StoredAssetKind.Cover);
	pushFsFiles(out, input.wallpapers, StoredAssetKind.Wallpaper);
	pushFsFiles(out, input.icons, StoredAssetKind.Icon);

	// Largest first — the inventory exists to answer "what's taking up space",
	// with newest as the tiebreak so same-size blobs stay deterministic.
	out.sort((a, b) => b.sizeBytes - a.sizeBytes || b.createdAt - a.createdAt);
	return out;
}

function pushFsFiles(
	out: StoredAsset[],
	files: readonly FsStoreFile[],
	kind: StoredAssetKind,
): void {
	for (const file of files) {
		out.push({
			id: file.hash,
			kind,
			name: file.name,
			mime: file.mime,
			sizeBytes: file.sizeBytes,
			url: file.url,
			thumbUrl: file.thumbUrl,
			createdAt: file.uploadedAt,
		});
	}
}
