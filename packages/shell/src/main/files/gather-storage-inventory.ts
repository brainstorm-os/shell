/**
 * gatherStorageInventory — the impure half of the Files "Storage" view:
 * pull each store's list, stat sizes off disk, normalize, then hand the rows
 * to the pure {@link buildStorageInventory}. Every side-effecting input
 * (the four listers + `statSize`) is injected, so the gathering + size/mime
 * derivation is unit-tested with fakes; the production wire in `index.ts`
 * supplies the real asset store + `listCovers`/`listIcons`/wallpaper readers.
 */

import { join } from "node:path";
import type { StoredAsset } from "@brainstorm-os/sdk-types";
import type { AssetRecord } from "../storage/entities-repo";
import { type FsStoreFile, buildStorageInventory } from "./storage-inventory";

/** The shape every content-addressed store's `list` returns (covers / icons),
 *  plus a synthesized one for wallpapers. `uploadedAt` is best-effort. */
export type FsStoreEntry = {
	readonly url: string;
	readonly thumbUrl: string | null;
	readonly hash: string;
	readonly uploadedAt: number;
};

export type StorageGatherDeps = {
	readonly vaultPath: string;
	readonly listBoundAssets: () => AssetRecord[];
	/** `assetId`s still referenced by a live entity — bound uploads outside
	 *  this set are orphaned (their owning File was deleted/purged) and are
	 *  excluded so the Storage view tracks reachable bytes, not stale blobs. */
	readonly liveAssetIds: () => ReadonlySet<string>;
	readonly listCovers: () => Promise<readonly FsStoreEntry[]>;
	readonly listWallpapers: () => Promise<readonly FsStoreEntry[]>;
	readonly listIcons: () => Promise<readonly FsStoreEntry[]>;
	/** Bytes on disk for an absolute path; `-1` when the stat fails. */
	readonly statSize: (absPath: string) => Promise<number>;
};

const EXT_MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".avif": "image/avif",
	".svg": "image/svg+xml",
};

function filenameFromUrl(url: string): string {
	const slash = url.lastIndexOf("/");
	return decodeURIComponent(slash >= 0 ? url.slice(slash + 1) : url);
}

function mimeForName(name: string): string {
	const dot = name.lastIndexOf(".");
	const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
	return EXT_MIME[ext] ?? "application/octet-stream";
}

async function toFsFiles(
	entries: readonly FsStoreEntry[],
	subdir: string,
	deps: StorageGatherDeps,
): Promise<FsStoreFile[]> {
	const out: FsStoreFile[] = [];
	for (const entry of entries) {
		const name = filenameFromUrl(entry.url);
		const sizeBytes = await deps.statSize(join(deps.vaultPath, subdir, name));
		out.push({
			hash: entry.hash,
			url: entry.url,
			thumbUrl: entry.thumbUrl,
			name,
			mime: mimeForName(name),
			sizeBytes,
			uploadedAt: entry.uploadedAt,
		});
	}
	return out;
}

export async function gatherStorageInventory(deps: StorageGatherDeps): Promise<StoredAsset[]> {
	const [covers, wallpapers, icons] = await Promise.all([
		deps.listCovers().then((e) => toFsFiles(e, "covers", deps)),
		deps.listWallpapers().then((e) => toFsFiles(e, join("dashboard", "wallpapers"), deps)),
		deps.listIcons().then((e) => toFsFiles(e, "icons", deps)),
	]);
	const live = deps.liveAssetIds();
	return buildStorageInventory({
		assets: deps.listBoundAssets().filter((a) => live.has(a.assetId)),
		covers,
		wallpapers,
		icons,
	});
}
