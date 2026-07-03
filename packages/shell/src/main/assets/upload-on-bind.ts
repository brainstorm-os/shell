/**
 * Asset-B4 — upload-on-bind: push a bound asset's encrypted chunks to the
 * durable node and record its manifest on the owning entity's Y.Doc.
 *
 * The owner-device push half (the mirror of `materialize-on-serve`). An asset's
 * bytes only leave the device when (a) it's referenced by an entity (an
 * `asset_refs` row exists) and (b) the live transport has the blob plane. The
 * wired trigger is the **connect-time drain** — `drainPendingUploads` over every
 * ref whenever the relay reaches a blob-plane state — which subsumes per-bind
 * for correctness (an asset bound between connects uploads on the next state
 * change). `uploadBoundAssetIfPending` is factored out so a future immediate
 * on-bind trigger can reuse it without a second code path.
 *
 * The manifest on the entity Y.Doc IS the "already uploaded" marker
 * (`uploadBoundAsset` installs it only after every chunk is confirmed on the
 * node), so a present manifest short-circuits — no re-read, no re-seal. This
 * also stops a cold device that merely *materialised* an asset from re-uploading
 * it (its owner already installed the manifest).
 *
 * Per-pair isolation + fail-safe: one asset's failure (not local, no DEK, node
 * error) is logged + skipped, never aborting the drain; the DEK is zeroed in a
 * `finally`.
 */

import type { AssetCas } from "./asset-cas";
import { type InstallManifest, uploadBoundAsset } from "./asset-sync";
import type { AssetKind } from "./asset-types";

/** Why a pair didn't upload (or that it did) — surfaced in the drain tally +
 *  logs, and asserted in tests. */
export enum UploadBoundOutcome {
	/** Chunks pushed (or confirmed present) + manifest installed this call. */
	Uploaded = "uploaded",
	/** A manifest was already on the entity — nothing to do. */
	AlreadyPresent = "already-present",
	/** The blob isn't local (a cold device that hasn't materialised it). */
	NotLocal = "not-local",
	/** The per-asset DEK couldn't be recovered for this entity. */
	NoDek = "no-dek",
}

export type UploadOnBindDeps = {
	cas: AssetCas;
	/** Install the manifest on the owning entity's Y.Doc (idempotent). */
	installManifest: InstallManifest;
	/** True if the entity already carries a valid manifest for the asset — the
	 *  upload-done marker. Skip the upload when so. */
	manifestPresent: (entityId: string, assetId: string) => Promise<boolean>;
	/** Open the LOCAL plaintext + mime (+ the row's `kind`, carried into the
	 *  manifest so a cold device reconstructs a faithful row — Asset-B5); null
	 *  when the blob isn't on this device. */
	readAsset: (
		assetId: string,
	) => Promise<{ bytes: Uint8Array; mime: string; kind?: AssetKind } | null>;
	/** Recover the per-asset DEK the chunks are sealed under (a FRESH buffer this
	 *  module zeroes), or null. */
	recoverDek: (entityId: string, assetId: string) => Promise<Uint8Array | null>;
};

/**
 * Upload one bound asset if it isn't already on the node. Idempotent + safe to
 * call repeatedly (a present manifest, or already-present chunks, are no-ops).
 */
export async function uploadBoundAssetIfPending(
	deps: UploadOnBindDeps,
	entityId: string,
	assetId: string,
): Promise<UploadBoundOutcome> {
	if (await deps.manifestPresent(entityId, assetId)) return UploadBoundOutcome.AlreadyPresent;
	const asset = await deps.readAsset(assetId);
	if (!asset) return UploadBoundOutcome.NotLocal;
	const dek = await deps.recoverDek(entityId, assetId);
	if (!dek) return UploadBoundOutcome.NoDek;
	try {
		await uploadBoundAsset(
			{ cas: deps.cas, installManifest: deps.installManifest },
			entityId,
			assetId,
			asset.mime,
			asset.bytes,
			dek,
			asset.kind,
		);
		return UploadBoundOutcome.Uploaded;
	} finally {
		dek.fill(0);
	}
}

export type DrainPendingUploadsResult = {
	uploaded: number;
	alreadyPresent: number;
	notLocal: number;
	noDek: number;
	/** Pairs that threw (per-pair error logged, drain continued). */
	failed: number;
};

/**
 * Drain a list of `(entityId, assetId)` pairs through `uploadBoundAssetIfPending`,
 * one at a time (bounded memory — each upload seals a chunk at a time), with
 * per-pair isolation. The caller enumerates the pairs (all `asset_refs`) and is
 * expected to have already confirmed the blob plane is live.
 */
export async function drainPendingUploads(
	deps: UploadOnBindDeps,
	pairs: Iterable<{ entityId: string; assetId: string }>,
): Promise<DrainPendingUploadsResult> {
	const result: DrainPendingUploadsResult = {
		uploaded: 0,
		alreadyPresent: 0,
		notLocal: 0,
		noDek: 0,
		failed: 0,
	};
	for (const { entityId, assetId } of pairs) {
		try {
			const outcome = await uploadBoundAssetIfPending(deps, entityId, assetId);
			switch (outcome) {
				case UploadBoundOutcome.Uploaded:
					result.uploaded += 1;
					break;
				case UploadBoundOutcome.AlreadyPresent:
					result.alreadyPresent += 1;
					break;
				case UploadBoundOutcome.NotLocal:
					result.notLocal += 1;
					break;
				case UploadBoundOutcome.NoDek:
					result.noDek += 1;
					break;
			}
		} catch (error) {
			result.failed += 1;
			console.warn(`[upload-on-bind] upload failed for ${entityId}/${assetId}:`, error);
		}
	}
	return result;
}
