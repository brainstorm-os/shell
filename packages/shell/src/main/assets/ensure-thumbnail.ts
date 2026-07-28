/**
 * Asset-B4b — derive-and-bind a thumbnail for a bound image asset, once.
 *
 * Runs on the OWNER device (the only device holding the plaintext): when an
 * image asset is bound to an entity (the implicit ref writer's `onAssetBound`,
 * plus a retrofit sweep in the connect-time drain), derive a preview via the
 * thumbnailer, store it as a first-class asset (`kind = thumbnail`, its own
 * random DEK — same non-convergence posture as every asset), link it on the
 * parent row (`assets.thumb_asset_id`), and bind it to the same entity under
 * the `thumbnail` role so the existing machinery — DEK re-home, upload drain,
 * GC ref-report — picks it up with zero special cases.
 *
 * Fail-soft everywhere: a thrown/declined derivation, a race with a
 * concurrent derivation (the SQL only-if-unset link decides the winner; the
 * loser deletes its orphan), or a not-local blob all leave the bind exactly
 * as it was — full-blob behavior never changes.
 */

import type { AssetRecord } from "../storage/entities-repo/assets-repo";
import { AssetKind } from "./asset-types";
import { THUMBNAIL_MIN_SOURCE_BYTES, type Thumbnailer, isThumbnailableMime } from "./thumbnailer";

/** Why an ensure call did / didn't produce a thumbnail — logged + asserted. */
export enum EnsureThumbnailOutcome {
	/** Derived + stored + linked + bound this call. */
	Created = "created",
	/** The parent already links a thumbnail (ref ensured for this entity). */
	AlreadyPresent = "already-present",
	/** Not an eligible source (no row, a thumbnail itself, non-image mime,
	 *  or below the size floor). */
	NotEligible = "not-eligible",
	/** The blob isn't local (a cold device never derives — it materialises). */
	NotLocal = "not-local",
	/** The thumbnailer declined (addon absent, undecodable, not smaller). */
	Declined = "declined",
	/** Lost the only-if-unset link race to a concurrent derivation. */
	LostRace = "lost-race",
}

export type EnsureThumbnailDeps = {
	getAsset: (assetId: string) => AssetRecord | null;
	/** Open the LOCAL plaintext, or null when the blob isn't on this device. */
	readAsset: (assetId: string) => Promise<{ bytes: Uint8Array; mime: string } | null>;
	thumbnailer: Thumbnailer;
	/** Store the derivative as a fresh `kind = thumbnail` asset (sealed, own
	 *  DEK) and stamp it bound. Returns its minted id. */
	writeThumbAsset: (input: { bytes: Uint8Array; mime: string }) => Promise<{ assetId: string }>;
	/** Set `assets.thumb_asset_id` on the parent ONLY if unset (SQL-guarded).
	 *  False ⇒ a concurrent derivation won. */
	linkThumb: (parentAssetId: string, thumbAssetId: string) => boolean;
	/** Delete a just-written orphan derivative after a lost race. */
	deleteAsset: (assetId: string) => Promise<void>;
	/** Bind the thumbnail to the entity under `AssetRefRole.Thumbnail`. Returns
	 *  true when the ref was NEWLY created (drives the push hook — a
	 *  pre-existing ref must not re-trigger uploads). */
	createRef: (entityId: string, thumbAssetId: string) => boolean;
	/** A fresh thumbnail ref landed — the wired consumer pushes it to the node
	 *  (mirrors the entities service's `onAssetBound`). Contained. */
	onThumbBound?: (entityId: string, thumbAssetId: string) => void;
};

/**
 * Ensure the (entity, asset) pair has its thumbnail derived, linked, and
 * bound. Idempotent; safe to call from both the per-bind hook and the drain.
 */
export async function ensureThumbnailForBoundAsset(
	deps: EnsureThumbnailDeps,
	entityId: string,
	assetId: string,
): Promise<EnsureThumbnailOutcome> {
	const row = deps.getAsset(assetId);
	if (!row || row.kind === AssetKind.Thumbnail) return EnsureThumbnailOutcome.NotEligible;
	if (row.thumbAssetId) {
		// Derived earlier (possibly for another entity) — just make sure THIS
		// entity binds it so the drains and GC see the pair.
		bindThumb(deps, entityId, row.thumbAssetId);
		return EnsureThumbnailOutcome.AlreadyPresent;
	}
	if (!isThumbnailableMime(row.mime) || row.byteLen <= THUMBNAIL_MIN_SOURCE_BYTES) {
		return EnsureThumbnailOutcome.NotEligible;
	}
	const asset = await deps.readAsset(assetId);
	if (!asset) return EnsureThumbnailOutcome.NotLocal;
	const thumb = await deps.thumbnailer(asset.bytes, asset.mime);
	if (!thumb) return EnsureThumbnailOutcome.Declined;
	const { assetId: thumbAssetId } = await deps.writeThumbAsset(thumb);
	if (!deps.linkThumb(assetId, thumbAssetId)) {
		// A concurrent derivation linked first — ours is an orphan; remove it
		// and bind the winner instead.
		await deps.deleteAsset(thumbAssetId).catch(() => {});
		const winner = deps.getAsset(assetId)?.thumbAssetId;
		if (winner) bindThumb(deps, entityId, winner);
		return EnsureThumbnailOutcome.LostRace;
	}
	bindThumb(deps, entityId, thumbAssetId);
	return EnsureThumbnailOutcome.Created;
}

function bindThumb(deps: EnsureThumbnailDeps, entityId: string, thumbAssetId: string): void {
	if (!deps.createRef(entityId, thumbAssetId)) return;
	try {
		deps.onThumbBound?.(entityId, thumbAssetId);
	} catch (error) {
		console.warn(`[ensure-thumbnail] onThumbBound hook failed for ${thumbAssetId}:`, error);
	}
}
