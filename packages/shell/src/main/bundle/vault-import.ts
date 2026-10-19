/**
 * `.bsbundle` → vault restore (IE-1).
 *
 * Writes a bundle's contents into a vault through the same privileged paths
 * the seeder uses (entity rows, Yjs snapshots, re-sealed blobs). Per doc 45
 * the canonical flow restores into a *fresh* vault (the caller creates an
 * empty vault, then calls this); merge-into-existing with conflict strategies
 * is the IE-2 engine's job, so this rung restores assuming a clean target and
 * reports any id that already exists rather than guessing a merge.
 *
 * Entity ids, timestamps, authorship, type registrations, links, and asset
 * ids are all preserved so a re-export reproduces the source bundle. Blobs are
 * re-sealed under the target vault's key (the DEK is per-vault), which is why
 * only the asset *id* — not its DEK — is preserved.
 *
 * Reserved (host-owned) property keys are always stripped: a bundle is
 * unauthenticated (its manifest's vault id is just a field), so there is no
 * sound way to tell this vault's own backup from a crafted file, and a forged
 * `agentProvenance` would read as "Created by <trusted agent>". Restoring a
 * backup therefore drops agent provenance, proposal cards and delegation marks.
 */

import { stripReservedProperties } from "@brainstorm-os/sdk-types";
import * as Y from "yjs";
import { AssetKind } from "../assets/asset-types";
import { EntitiesRepository } from "../storage/entities-repo";
import type { VaultSession } from "../vault/session";
import { unpackBundle } from "./bundle-archive";
import {
	type BundleAssetRecord,
	type BundleEntityRecord,
	type BundleLinkRecord,
	type BundleManifest,
	BundlePath,
	type ImportReport,
	assertSafeBundleId,
} from "./bundle-format";
import { parseJsonl } from "./canonical-json";

export type ImportVaultOptions = {
	/** Wall-clock for import-side stamps (ms). */
	readonly now: number;
	/** Identity recorded as `importedBy` on restored provenance. */
	readonly importedBy: string;
};

const dec = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : "");

function majorOf(semver: string): number {
	return Number.parseInt(semver.split(".")[0] ?? "", 10);
}

function assetKindFromString(value: string): AssetKind {
	for (const kind of Object.values(AssetKind)) {
		if (kind === value) return kind;
	}
	return AssetKind.Upload;
}

export async function importVaultBundle(
	session: VaultSession,
	bundle: Uint8Array,
	options: ImportVaultOptions,
): Promise<ImportReport> {
	if (!options.importedBy)
		throw new Error("bundle: importVaultBundle requires an importedBy identity");
	const files = unpackBundle(bundle);

	const manifestText = dec(files.get(BundlePath.Manifest));
	if (!manifestText) throw new Error("bundle: missing manifest.json");
	const manifest = JSON.parse(manifestText) as BundleManifest;
	const major = majorOf(manifest.bundleFormatVersion);
	if (!Number.isFinite(major) || major !== 1) {
		throw new Error(`bundle: unsupported bundleFormatVersion ${manifest.bundleFormatVersion}`);
	}

	const entitiesDb = await session.dataStores.open("entities");
	const entitiesRepo = new EntitiesRepository(entitiesDb);
	const assetStore = await session.assetStore();

	// --- restore blobs (re-sealed under the target vault key, id preserved) ---
	const assetMeta = parseJsonl(dec(files.get(BundlePath.AssetsManifest))) as BundleAssetRecord[];
	let assetsWritten = 0;
	for (const meta of assetMeta) {
		assertSafeBundleId("asset", meta.assetId);
		const blob = files.get(`${BundlePath.BlobsDir}${meta.contentHash}`);
		if (!blob) continue;
		await assetStore.writeAsset({
			assetId: meta.assetId,
			bytes: blob,
			mime: meta.mime,
			kind: assetKindFromString(meta.kind),
			originUrl: meta.originUrl,
		});
		if (meta.bound) assetStore.markBound(meta.assetId);
		assetsWritten++;
	}

	// --- restore entities + rich-text bodies ---
	const created: string[] = [];
	const skipped: string[] = [];
	const failed: Array<{ id: string; reason: string }> = [];
	for (const [path, bytes] of files) {
		if (!path.startsWith(BundlePath.EntitiesDir)) continue;
		const record = JSON.parse(dec(bytes)) as BundleEntityRecord;
		assertSafeBundleId("entity", record.id);
		if (entitiesRepo.get(record.id)) {
			skipped.push(record.id);
			continue;
		}
		try {
			entitiesRepo.create({
				id: record.id,
				type: record.type,
				properties: stripReservedProperties(record.properties ?? {}),
				createdBy: record.createdBy,
				spaceId: record.spaceId,
				now: record.createdAt ?? options.now,
				updatedAt: record.updatedAt ?? options.now,
				dekId: null,
			});
			const ydoc = files.get(`${BundlePath.YdocDir}${record.id}.bin`);
			if (ydoc && ydoc.length > 0) {
				const doc = new Y.Doc();
				Y.applyUpdate(doc, ydoc);
				await session.ydocStore.writeSnapshot(record.id, Y.encodeStateAsUpdate(doc));
				doc.destroy();
			}
			created.push(record.id);
		} catch (error) {
			failed.push({ id: record.id, reason: error instanceof Error ? error.message : String(error) });
		}
	}

	// --- restore links (skip dangling — endpoint may have been skipped) ---
	const links = parseJsonl(dec(files.get(BundlePath.Links))) as BundleLinkRecord[];
	let linksRestored = 0;
	const live = new Set(created);
	for (const link of links) {
		if (!live.has(link.sourceEntityId) || !live.has(link.destEntityId)) continue;
		entitiesRepo.putLink({
			id: link.id,
			sourceEntityId: link.sourceEntityId,
			destEntityId: link.destEntityId,
			linkType: link.linkType,
			createdAt: link.createdAt,
		});
		linksRestored++;
	}

	return {
		created: created.length,
		skipped: skipped.length,
		failed,
		linksRestored,
		assetsWritten,
	};
}
