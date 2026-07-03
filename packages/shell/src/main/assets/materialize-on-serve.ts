/**
 * Asset-B4 — serve-on-miss: materialise a synced asset's bytes on the fly when
 * `brainstorm://asset/<id>` is requested but the encrypted blob file is absent.
 *
 * The lazy-fetch path (Asset-B4's "materialise on access, not eagerly on
 * restore"). It targets the **metadata-present, blob-absent** state: the local
 * `assets` row, its `asset_refs` binding, and its `asset_deks` DEK are all
 * present (restored from backup, or retained after a selective-sync eviction),
 * but the `<vault>/data/assets/<id>.enc` file is missing — so `readAsset`
 * returns null on the blob read. This resolves the owning entity from the ref,
 * recovers the per-asset DEK, reads the chunk manifest off the entity Y.Doc, and
 * fetches + verifies + reassembles the chunks from the durable node, then
 * re-seals the plaintext into the blob file under the asset's EXISTING DEK so
 * the next serve is a plain read. (The true cold-first-fetch case — a device
 * that never had the asset's row, so the FK forbids the ref — needs asset-
 * metadata reconstruction from the synced manifest and is a later rung.)
 *
 * Fail-closed throughout: no node plane → null (offline serves nothing new); a
 * ref whose DEK/manifest can't be recovered → try the next ref, else null; a
 * tampered/lying node (AEAD or content-address mismatch) → the materialize
 * throws, is caught, and we fall through to null (a 404), never a partial or
 * error-distinguishable response. A blob re-write failure never blocks serving
 * the bytes already in hand.
 *
 * Content-Type safety: the mime rides the untrusted peer manifest. It's
 * syntactically validated on manifest read (`normalizeManifestMime`) and here
 * additionally passes through `serveSafeMime` — a script-capable type
 * (svg / html / xml) a peer could name to run script in the asset origin is
 * downgraded to `application/octet-stream` (inert) for this materialised path.
 */

import type { AssetCas } from "./asset-cas";
import { DEFAULT_ASSET_MIME } from "./asset-chunks";
import { materializeAsset } from "./asset-sync";

/** MIME types safe to hand back inline for a materialised (peer-manifest-sourced)
 *  asset: raster images the renderer displays without executing, plus PDF. A
 *  type NOT on this list — notably `image/svg+xml`, `text/html`,
 *  `application/xhtml+xml`, any `*+xml` — is served as the inert default so a
 *  hostile peer manifest can't get active content executed in the asset origin. */
const SERVE_SAFE_MIME = new Set<string>([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"image/avif",
	"image/bmp",
	"image/x-icon",
	"image/vnd.microsoft.icon",
	"application/pdf",
]);

/** Downgrade a materialised asset's mime to the inert default unless it is a
 *  known-safe, non-script-capable type. */
export function serveSafeMime(mime: string): string {
	return SERVE_SAFE_MIME.has(mime) ? mime : DEFAULT_ASSET_MIME;
}

export type MaterializeOnServeDeps = {
	/** Whether the live transport can carry the blob plane (durable node, not a
	 *  loopback). Probed BEFORE any work so an offline device serves nothing new
	 *  rather than attempting + failing per ref. */
	hasAssetPlane: () => boolean;
	/** The entity ids referencing this asset (from `asset_refs.listByAsset`,
	 *  mapped to `entityId`). Each is a candidate owner whose Y.Doc may carry the
	 *  manifest + DEK wrap. */
	listRefEntities: (assetId: string) => string[];
	/** Recover the per-asset DEK for a given owning entity (master-key cache or
	 *  the re-homed entity-DEK wrap). Returns a FRESH buffer this module zeroes,
	 *  or null when the key isn't recoverable for that entity. */
	recoverDek: (entityId: string, assetId: string) => Promise<Uint8Array | null>;
	/** Read the raw (untrusted) chunk manifest value off the entity Y.Doc. */
	readManifest: (entityId: string, assetId: string) => Promise<unknown>;
	/** The node CAS bound to the live relay (fetch chunks by ciphertext-hash). */
	cas: AssetCas;
	/** Re-seal the materialised plaintext into the asset's blob file under its
	 *  EXISTING local DEK (the `assets` + `asset_deks` rows already exist — only
	 *  the file was missing). Best-effort: a failure never blocks the serve. */
	restoreBlob: (assetId: string, plaintext: Uint8Array) => Promise<void>;
};

export type MaterializeOnServeResult = { bytes: Uint8Array; mime: string };

/**
 * Try to materialise + restore a blob-absent asset. Returns the bytes + a
 * serve-safe mime, or null when it can't be produced (offline, no recoverable
 * ref, or an untrusted-node failure) — the caller then 404s.
 */
export async function materializeAssetOnServe(
	deps: MaterializeOnServeDeps,
	assetId: string,
): Promise<MaterializeOnServeResult | null> {
	if (!deps.hasAssetPlane()) return null;

	for (const entityId of deps.listRefEntities(assetId)) {
		const dek = await deps.recoverDek(entityId, assetId);
		if (!dek) continue;
		try {
			const got = await materializeAsset(
				{ cas: deps.cas, readManifest: deps.readManifest },
				entityId,
				assetId,
				dek,
			);
			if (!got) continue;
			// Best-effort local restore; a write failure must not fail the serve.
			try {
				await deps.restoreBlob(assetId, got.bytes);
			} catch (error) {
				console.warn(`[materialize-on-serve] blob restore failed for ${assetId}:`, error);
			}
			return { bytes: got.bytes, mime: serveSafeMime(got.mime) };
		} catch (error) {
			// A tampered/lying node (AEAD or content-address mismatch), a manifest
			// id mismatch, or a missing chunk — fail closed: try the next ref, and
			// if none succeed the caller 404s. Never leak a partial.
			console.warn(`[materialize-on-serve] materialize failed for ${assetId}:`, error);
		} finally {
			dek.fill(0);
		}
	}
	return null;
}
