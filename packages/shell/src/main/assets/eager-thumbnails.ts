/**
 * Asset-B4b — the eager (always-synced) thumbnail tier's materialise drain.
 *
 * Full blobs stay lazy (`materialize-on-serve` fetches them on first access);
 * thumbnails are the one tier a device pulls PROACTIVELY so galleries and
 * inspectors never render empty on a cold/second device. The drain walks the
 * `thumbnail`-role ref pairs (created locally by `ensure-thumbnail`, or on a
 * cold device by the B5 reconstruct pass) and, for each pair whose blob file
 * is absent, runs the SAME untrusted-node materialise path as serve-on-miss —
 * manifest validated fail-closed, chunks verified + opened under the
 * entity-recovered DEK, `restoreBlob`'s hash/length pinning intact.
 *
 * Bounded by construction: thumbnails are ≤ ~100 KiB derivatives, so the
 * whole tier is a few MiB even for a large library. Per-pair isolation: one
 * failure (offline mid-drain, a tampered chunk, a missing wrap) is counted +
 * logged, never aborting the pass. Triggered from the same relay-state hook
 * as the upload drain; both are idempotent, so firing on every state change
 * is safe.
 */

import type { AssetCas } from "./asset-cas";
import { materializeAsset } from "./asset-sync";

export type EagerThumbnailDeps = {
	/** Cheap blob-file presence probe (`AssetStore.hasBlob`). */
	hasBlob: (assetId: string) => Promise<boolean>;
	/** Recover the per-asset DEK for the pair (a FRESH buffer this module
	 *  zeroes), or null. */
	recoverDek: (entityId: string, assetId: string) => Promise<Uint8Array | null>;
	/** Read the raw (untrusted) chunk manifest off the entity Y.Doc. */
	readManifest: (entityId: string, assetId: string) => Promise<unknown>;
	/** The node CAS bound to the live relay. */
	cas: AssetCas;
	/** Re-seal the materialised plaintext into the blob file under the asset's
	 *  existing DEK (`AssetStore.restoreBlob` — hash/length pinned). */
	restoreBlob: (assetId: string, plaintext: Uint8Array) => Promise<void>;
};

export type EagerThumbnailTally = {
	/** Pairs whose bytes were fetched + restored this pass. */
	materialized: number;
	/** Pairs whose blob file was already on disk. */
	alreadyLocal: number;
	/** No recoverable DEK for the pair — skipped (retryable later). */
	noDek: number;
	/** No (valid) manifest on the entity — not uploaded yet, or hostile. */
	noManifest: number;
	/** Pairs that threw (tampered node, restore failure) — logged, continued. */
	failed: number;
};

/**
 * Materialise every absent thumbnail in `pairs`. Never throws for a single
 * bad pair; returns the tally.
 */
export async function drainEagerThumbnails(
	deps: EagerThumbnailDeps,
	pairs: Iterable<{ entityId: string; assetId: string }>,
): Promise<EagerThumbnailTally> {
	const tally: EagerThumbnailTally = {
		materialized: 0,
		alreadyLocal: 0,
		noDek: 0,
		noManifest: 0,
		failed: 0,
	};
	for (const { entityId, assetId } of pairs) {
		try {
			if (await deps.hasBlob(assetId)) {
				tally.alreadyLocal += 1;
				continue;
			}
			const dek = await deps.recoverDek(entityId, assetId);
			if (!dek) {
				tally.noDek += 1;
				continue;
			}
			try {
				const got = await materializeAsset(
					{ cas: deps.cas, readManifest: deps.readManifest },
					entityId,
					assetId,
					dek,
				);
				if (!got) {
					tally.noManifest += 1;
					continue;
				}
				await deps.restoreBlob(assetId, got.bytes);
				tally.materialized += 1;
			} finally {
				dek.fill(0);
			}
		} catch (error) {
			tally.failed += 1;
			console.warn(`[eager-thumbnails] materialise failed for ${entityId}/${assetId}:`, error);
		}
	}
	return tally;
}
