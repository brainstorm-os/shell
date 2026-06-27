/**
 * The client up/download path for the blob plane (Asset-B2, design
 * [data/70 §Chunking and transfer]).
 *
 * `uploadAsset` chunks a blob, seals each chunk one-at-a-time (never holding the
 * whole sealed blob), skips chunks already on the node (`has`), PUTs the rest,
 * and returns the ordered manifest to write onto the entity's asset reference.
 * `downloadAsset` fetches + verifies + opens each chunk via the manifest and
 * reassembles the plaintext.
 *
 * Both target the `AssetCas` contract — the node (Asset-B3) implements it over
 * the wire; tests use `MemoryAssetCas`. The per-asset DEK is the one Asset-B1
 * re-homed into the entity Y.Doc, so a paired device that holds the entity DEK
 * can derive it and open the chunks.
 */

import type { AssetCas } from "./asset-cas";
import {
	ASSET_CHUNK_BYTES,
	type AssetChunkManifest,
	type AssetChunkRef,
	chunkCount,
	openOneChunk,
	sealOneChunk,
} from "./asset-chunks";

export type UploadAssetResult = {
	manifest: AssetChunkManifest;
	/** Chunks actually PUT (the rest were already on the node). */
	uploaded: number;
	/** Chunks skipped because the node already had them (`has` hit). */
	skipped: number;
};

/**
 * Seal `plaintext` into chunks, upload the ones the node doesn't already have,
 * and return the manifest + a small upload summary. Seals one chunk at a time;
 * a `put` failure aborts the whole upload (the caller writes the manifest to the
 * entity only on success, so a partial upload never produces a referenceable
 * manifest).
 */
export async function uploadAsset(
	plaintext: Uint8Array,
	dek: Uint8Array,
	assetId: string,
	cas: AssetCas,
	chunkBytes: number = ASSET_CHUNK_BYTES,
): Promise<UploadAssetResult> {
	const count = chunkCount(plaintext.length, chunkBytes);
	const chunks: AssetChunkRef[] = [];
	let uploaded = 0;
	let skipped = 0;
	for (let i = 0; i < count; i += 1) {
		const start = i * chunkBytes;
		const raw = plaintext.subarray(start, Math.min(start + chunkBytes, plaintext.length));
		const { ref, enc } = sealOneChunk(raw, dek, assetId, i);
		chunks.push(ref);
		if (await cas.has(ref.hash)) {
			skipped += 1;
		} else {
			await cas.put(ref.hash, enc);
			uploaded += 1;
		}
	}
	return {
		manifest: { v: 1, assetId, chunkBytes, totalRawLen: plaintext.length, chunks },
		uploaded,
		skipped,
	};
}

/**
 * Reassemble a blob from its manifest by fetching each sealed chunk from the
 * CAS, verifying its content address + length, and opening it under `dek`.
 * Throws on a missing chunk, an address mismatch, an AEAD failure, or a size
 * mismatch (every failure mode is detected — the node is untrusted).
 */
export async function downloadAsset(
	manifest: AssetChunkManifest,
	dek: Uint8Array,
	cas: AssetCas,
): Promise<Uint8Array> {
	if (manifest.v !== 1) {
		throw new Error(`downloadAsset: unsupported manifest v=${String(manifest.v)}`);
	}
	const out = new Uint8Array(manifest.totalRawLen);
	let offset = 0;
	for (let i = 0; i < manifest.chunks.length; i += 1) {
		const ref = manifest.chunks[i];
		if (!ref) throw new Error(`downloadAsset: missing manifest entry ${i}`);
		const enc = await cas.get(ref.hash);
		if (!enc) throw new Error(`downloadAsset: chunk ${i} (${ref.hash}) not on node`);
		const raw = openOneChunk(enc, dek, manifest.assetId, i, ref);
		out.set(raw, offset);
		offset += raw.length;
	}
	if (offset !== manifest.totalRawLen) {
		throw new Error(`downloadAsset: reassembled ${offset} != manifest ${manifest.totalRawLen}`);
	}
	return out;
}

/** True if every chunk in the manifest is present on the node (a fully-synced
 *  blob). Lets a caller decide between a local-hit and a fetch. */
export async function isAssetMaterialized(
	manifest: AssetChunkManifest,
	cas: AssetCas,
): Promise<boolean> {
	for (const ref of manifest.chunks) {
		if (!(await cas.has(ref.hash))) return false;
	}
	return true;
}
