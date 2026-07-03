/**
 * Asset-B5 — cold-first-fetch metadata reconstruction: rebuild the local
 * `assets` + `asset_deks` + `asset_refs` rows for assets that exist ONLY on
 * the metadata plane (a chunk manifest + re-homed DEK wrap on a synced entity
 * Y.Doc). This is the rung the B4 serve-on-miss header deferred: a true cold
 * device (restore-from-zero, or a shared entity arriving on a second device)
 * has no `assets` row, so the FK forbids the ref, so serve-on-miss can't even
 * find an owning entity. After this pass the metadata-present, blob-absent
 * invariant holds and bytes stay LAZY — serve-on-miss materialises them on
 * first access, exactly per the design ("materialise on access, not eagerly
 * on restore", data/70).
 *
 * Trust model: the manifest is peer-authored and validated
 * (`parseAssetChunkManifest`); its `kind` is advisory (absent/unknown → the
 * `upload` default). The DEK comes off the entity's own re-homed wrap opened
 * under the entity DEK — the same trust as the entity's content. The row's
 * `content_hash` starts as the reconstructed sentinel and is backfilled on
 * first materialise (`AssetStore.restoreBlob`); transport integrity is the
 * chunk AEAD, not this local hint.
 *
 * Fail-safe per asset: one bad manifest / missing wrap never aborts the pass;
 * the tally reports what happened. Idempotent: present rows short-circuit,
 * refs are created only when absent.
 */

import { assetRefRoleForKind } from "../entities/derive-asset-refs";
import { parseAssetChunkManifest } from "./asset-chunks";
import { AssetKind, type AssetRefRole } from "./asset-types";

export type ReconstructDeps = {
	/** Every (assetId → raw manifest) pair on the entity's Y.Doc. */
	listManifests: (entityId: string) => Promise<Array<{ assetId: string; manifest: unknown }>>;
	/** Whether a local `assets` row already exists. */
	hasAsset: (assetId: string) => boolean;
	/** Recover the per-asset DEK for this entity (re-homed wrap; a FRESH buffer
	 *  this module zeroes), or null. */
	recoverDek: (entityId: string, assetId: string) => Promise<Uint8Array | null>;
	/** Insert the `assets` + `asset_deks` rows (sentinel hash, marked bound) —
	 *  `AssetStore.registerSynced`. False when the row appeared concurrently. */
	registerSynced: (input: {
		assetId: string;
		mime: string;
		byteLen: number;
		kind: AssetKind;
		dek: Uint8Array;
	}) => boolean;
	/** True when the (entityId, assetId) ref row already exists. */
	hasRef: (entityId: string, assetId: string) => boolean;
	/** Insert an `asset_refs` row (the entity → asset binding). */
	createRef: (entityId: string, assetId: string, role: AssetRefRole) => void;
};

export type ReconstructTally = {
	/** Rows reconstructed (assets + DEK cache + ref). */
	created: number;
	/** Manifests whose asset row already existed (ref ensured). */
	present: number;
	/** Manifests that failed validation — skipped. */
	badManifest: number;
	/** No recoverable DEK wrap for the pair — skipped (retryable later). */
	noDek: number;
	/** Pairs that threw (logged, pass continued). */
	failed: number;
};

/**
 * Reconstruct asset metadata for a set of entities (typically a restore
 * summary's `entityIds`). Returns the tally; never throws for a single bad
 * pair.
 */
export async function reconstructAssetMetadata(
	deps: ReconstructDeps,
	entityIds: readonly string[],
): Promise<ReconstructTally> {
	const tally: ReconstructTally = { created: 0, present: 0, badManifest: 0, noDek: 0, failed: 0 };
	for (const entityId of entityIds) {
		let pairs: Array<{ assetId: string; manifest: unknown }>;
		try {
			pairs = await deps.listManifests(entityId);
		} catch (error) {
			tally.failed += 1;
			console.warn(`[reconstruct-assets] listManifests failed for ${entityId}:`, error);
			continue;
		}
		for (const { assetId, manifest: raw } of pairs) {
			try {
				const manifest = parseAssetChunkManifest(raw);
				if (!manifest || manifest.assetId !== assetId) {
					tally.badManifest += 1;
					continue;
				}
				const kind = manifest.kind ?? AssetKind.Upload;
				if (deps.hasAsset(assetId)) {
					ensureRef(deps, entityId, assetId, kind);
					tally.present += 1;
					continue;
				}
				const dek = await deps.recoverDek(entityId, assetId);
				if (!dek) {
					tally.noDek += 1;
					continue;
				}
				try {
					deps.registerSynced({
						assetId,
						mime: manifest.mime,
						byteLen: manifest.totalRawLen,
						kind,
						dek,
					});
				} finally {
					dek.fill(0);
				}
				ensureRef(deps, entityId, assetId, kind);
				tally.created += 1;
			} catch (error) {
				tally.failed += 1;
				console.warn(`[reconstruct-assets] failed for ${entityId}/${assetId}:`, error);
			}
		}
	}
	return tally;
}

function ensureRef(
	deps: ReconstructDeps,
	entityId: string,
	assetId: string,
	kind: AssetKind,
): void {
	if (!deps.hasRef(entityId, assetId)) {
		deps.createRef(entityId, assetId, assetRefRoleForKind(kind));
	}
}
