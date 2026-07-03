/**
 * Asset-B4 — the blob lifecycle orchestration: upload a bound asset's chunks to
 * the durable node + record the manifest on the entity, and the inverse —
 * materialise a synced asset's bytes on access by reading its manifest off the
 * entity and fetching its chunks back.
 *
 * This is thin glue over the Asset-B2 client transport (`uploadAsset` /
 * `downloadAsset`), the manifest store (the entity Y.Doc, Asset-B4 foundation),
 * and the node CAS (`WireAssetCas` over the live relay). The sensitive parts —
 * opening the blob plaintext, recovering the per-asset DEK (from the local
 * master-key cache or the re-homed wrap on the entity Y.Doc), and caching a
 * materialised blob locally — stay at the wiring layer and are passed in, so
 * this module is pure orchestration and unit-testable against an in-memory CAS.
 */

import type { AssetCas } from "./asset-cas";
import { type AssetChunkManifest, parseAssetChunkManifest } from "./asset-chunks";
import { type UploadAssetResult, downloadAsset, uploadAsset } from "./asset-transport";

export type InstallManifest = (
	entityId: string,
	assetId: string,
	manifest: AssetChunkManifest,
) => Promise<unknown>;

/** Read the raw manifest value off the entity (validated here, not trusted). */
export type ReadManifest = (entityId: string, assetId: string) => Promise<unknown>;

/**
 * Upload a bound asset's chunks to the node (skipping ones already present) and
 * record the ordered manifest on the referencing entity's Y.Doc. The caller
 * supplies the already-opened plaintext + per-asset DEK (and zeroes the DEK
 * afterward). Returns the upload summary; the manifest is installed only after
 * every chunk is confirmed on the node, so a partial upload never leaves a
 * referenceable-but-unfetchable manifest.
 */
export async function uploadBoundAsset(
	deps: { cas: AssetCas; installManifest: InstallManifest },
	entityId: string,
	assetId: string,
	mime: string,
	plaintext: Uint8Array,
	dek: Uint8Array,
): Promise<UploadAssetResult> {
	const result = await uploadAsset(plaintext, dek, assetId, mime, deps.cas);
	await deps.installManifest(entityId, assetId, result.manifest);
	return result;
}

/**
 * Materialise a synced asset's bytes: read its manifest off the entity,
 * validate it (a peer authored it — fail closed), fetch + verify + open +
 * reassemble its chunks from the node under the supplied DEK. Returns the
 * plaintext + the manifest's (validated) mime, or null if the entity carries no
 * (valid) manifest for the asset (it hasn't been uploaded yet, or this device
 * can't see it).
 */
export async function materializeAsset(
	deps: { cas: AssetCas; readManifest: ReadManifest },
	entityId: string,
	assetId: string,
	dek: Uint8Array,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
	const raw = await deps.readManifest(entityId, assetId);
	const manifest = parseAssetChunkManifest(raw);
	if (!manifest) return null;
	if (manifest.assetId !== assetId) {
		throw new Error(`materializeAsset: manifest assetId ${manifest.assetId} != ${assetId}`);
	}
	const bytes = await downloadAsset(manifest, dek, deps.cas);
	return { bytes, mime: manifest.mime };
}
