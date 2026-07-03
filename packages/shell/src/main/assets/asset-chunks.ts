/**
 * Asset chunking + per-chunk sealing for the blob-plane sync transport
 * (Asset-B2, design [data/70 §Chunking and transfer]).
 *
 * A blob is split into fixed-size (4 MiB) chunks; each chunk is independently
 * sealed under the asset's per-asset DEK — the SAME DEK the at-rest blob uses,
 * re-homed into the referencing entity's Y.Doc by Asset-B1 — and
 * content-addressed by the sha256 of its **ciphertext** (never plaintext, so
 * the wire stays blind to plaintext equality, OQ-236). The ordered manifest of
 * chunk hashes + sizes rides the entity's asset reference on the metadata
 * plane; the chunks themselves ride the blob plane (PUT/GET/HAS by
 * ciphertext-hash to the durable node CAS, Asset-B3).
 *
 * Each chunk's AEAD is AAD-bound to `(assetId, index)`, so a chunk cannot be
 * replayed at a different position or under a different asset even by a holder
 * of the DEK. The seal nonce is random per chunk (v1): assets are immutable —
 * each upload mints a fresh `assetId` — so a blob is chunked exactly once and
 * the returned manifest is the authoritative record of what was sealed.
 * Content-defined chunking (stable addresses for delta-dedup) is a later
 * optimization behind this same manifest (design §133).
 *
 * Memory: the per-chunk primitives (`sealOneChunk` / `openOneChunk`) let the
 * transport seal/open ONE chunk at a time and never hold a multi-GB buffer; the
 * whole-blob convenience wrappers are for small assets + tests.
 */

import { createHash, createHmac } from "node:crypto";
import { XCHACHA_NONCE_BYTES, openBytes, sealBytesWithNonce } from "../credentials/crypto";
import { AssetKind } from "./asset-types";

/** Default chunk size on the wire — 4 MiB (design 70 §Chunking). */
export const ASSET_CHUNK_BYTES = 4 * 1024 * 1024;

const CHUNK_AAD_PREFIX = "brainstorm/asset-chunk/v1:";
const CHUNK_NONCE_DOMAIN = "brainstorm/asset-chunk-nonce/v1:";

/** One chunk's entry in the manifest: its content address (sha256 hex of the
 *  sealed ciphertext), the sealed byte length, and the plaintext byte length
 *  (so reassembly validates each chunk's size without trusting the bytes). */
export type AssetChunkRef = {
	/** sha256(sealedChunk) hex — the node CAS address. */
	hash: string;
	/** Sealed (nonce ++ ciphertext ++ tag) byte length. */
	encLen: number;
	/** Plaintext byte length of this chunk. */
	rawLen: number;
};

/** The ordered chunk manifest that rides the entity's asset reference. JSON-
 *  serialisable so it lives directly on the entity (metadata plane). */
export type AssetChunkManifest = {
	v: 1;
	assetId: string;
	/** The blob's MIME type — the ONLY per-asset metadata that crosses to a cold
	 *  device (the local `assets` row doesn't exist there), so serve-on-miss
	 *  needs it for the `Content-Type`. Peer-authored + unsigned → validated on
	 *  read (`parseAssetChunkManifest`) to a strict token shape; the serve layer
	 *  additionally decides which types are safe to hand back active (svg/html
	 *  are script-capable — see the serve-on-miss wiring). */
	mime: string;
	/** The chunk size used; the last chunk may be smaller. */
	chunkBytes: number;
	/** Total plaintext size (== sum of every `rawLen`). */
	totalRawLen: number;
	/** Ordered chunks — array position IS the chunk index. */
	chunks: AssetChunkRef[];
	/** Asset-B5 — the asset's `kind` (favicon/cover/upload), carried so a cold
	 *  device can reconstruct a faithful `assets` row. Peer-authored ADVISORY
	 *  metadata: validated against the enum on read; an absent or unknown value
	 *  degrades to `upload` at reconstruction and never rejects the manifest
	 *  (byte integrity is the chunk AEAD's job, not this label's). Optional
	 *  because pre-B5 manifests lack it and install is idempotent-no-overwrite,
	 *  so they never upgrade in place. */
	kind?: AssetKind;
};

/** Validate an untrusted manifest `kind` against the enum; anything else is
 *  treated as absent (the reconstruction default `upload` applies). */
function parseManifestKind(value: unknown): AssetKind | undefined {
	return typeof value === "string" && (Object.values(AssetKind) as string[]).includes(value)
		? (value as AssetKind)
		: undefined;
}

/** Fallback when a manifest carries no `mime` (older Asset-B2/B3 dogfood
 *  manifests predate the field). `octet-stream` is inert — it never renders as
 *  active content, so an absent/omitted mime can only under-serve, never XSS. */
export const DEFAULT_ASSET_MIME = "application/octet-stream";

/** A strict MIME `type/subtype` token: RFC-2045 `restricted-name` chars only, so
 *  a peer manifest can't smuggle CRLF / control bytes into a response header
 *  (`Content-Type` injection) or an over-long value. Active-content *policy*
 *  (which valid types are safe to serve un-sniffed) is enforced separately at
 *  the serve layer — this only bounds the syntax. */
const MIME_TOKEN_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/i;

/** Validate an untrusted manifest `mime`: absent → the inert default; a valid
 *  token → itself (lower-cased); anything else → null so the caller fails the
 *  whole manifest closed. */
export function normalizeManifestMime(value: unknown): string | null {
	if (value === undefined || value === null) return DEFAULT_ASSET_MIME;
	if (typeof value !== "string") return null;
	if (!MIME_TOKEN_RE.test(value)) return null;
	return value.toLowerCase();
}

/** AAD binding a chunk to its `(assetId, index)` position. NUL-separated so the
 *  id can't run into the index. */
function chunkAad(assetId: string, index: number): Uint8Array {
	return new TextEncoder().encode(`${CHUNK_AAD_PREFIX}${assetId}\0${index}`);
}

/** Synthetic IV for a chunk: a keyed (DEK) hash over its content + position, so
 *  the same chunk always seals to the same ciphertext → a stable content
 *  address (resume + skip-already-present), while DIFFERENT content yields a
 *  different nonce (no `(key, nonce)` reuse). The DEK in the HMAC key keeps the
 *  nonce unpredictable without it; the per-asset-random DEK (OQ-236) keeps
 *  identical plaintext across assets/users from colliding. */
function chunkNonce(dek: Uint8Array, assetId: string, index: number, raw: Uint8Array): Uint8Array {
	const idx = Buffer.alloc(4);
	idx.writeUInt32BE(index >>> 0);
	const mac = createHmac("sha256", dek)
		.update(CHUNK_NONCE_DOMAIN)
		.update(assetId)
		.update("\0")
		.update(idx)
		.update(raw)
		.digest();
	return new Uint8Array(mac.subarray(0, XCHACHA_NONCE_BYTES));
}

function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Hard ceiling on a manifest's declared total plaintext size. The untrusted
 * reassembly buffer (`new Uint8Array(totalRawLen)`) is allocated UP FRONT from
 * this field, before any chunk is fetched/verified — so a lying peer manifest
 * (it rides the entity Y.Doc unsigned) must not be able to name a multi-GB
 * total and OOM the victim on first materialise. Matches the 2 GiB upload cap
 * (9.10a `MAX_UPLOAD_BYTES`); a genuinely larger asset is out of v1 scope.
 */
export const MAX_ASSET_RAW_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Validate an UNTRUSTED manifest read off a synced entity (a peer authored it)
 * before it drives any fetch. Returns the typed manifest or null on any
 * deviation — fail closed. Checks version / id / chunk-array shape / 64-hex
 * addresses / non-negative integer lengths, and the integrity constraints that
 * bound the up-front reassembly allocation: `chunkBytes` and `totalRawLen` are
 * each `≤ MAX_ASSET_RAW_BYTES`, every chunk's `rawLen ≤ chunkBytes`, the
 * per-chunk `rawLen` sum to `totalRawLen`, and the chunk COUNT is exactly the
 * fixed-size split of the declared total (so a peer can't pad the count or
 * declare a total the chunks don't account for).
 */
export function parseAssetChunkManifest(value: unknown): AssetChunkManifest | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const m = value as Record<string, unknown>;
	if (m.v !== 1) return null;
	if (typeof m.assetId !== "string" || m.assetId.length === 0) return null;
	if (
		typeof m.chunkBytes !== "number" ||
		!Number.isInteger(m.chunkBytes) ||
		m.chunkBytes <= 0 ||
		m.chunkBytes > MAX_ASSET_RAW_BYTES
	) {
		return null;
	}
	if (
		typeof m.totalRawLen !== "number" ||
		!Number.isInteger(m.totalRawLen) ||
		m.totalRawLen < 0 ||
		m.totalRawLen > MAX_ASSET_RAW_BYTES
	) {
		return null;
	}
	const mime = normalizeManifestMime(m.mime);
	if (mime === null) return null;
	if (!Array.isArray(m.chunks) || m.chunks.length === 0) return null;
	// The chunk count is fully determined by (totalRawLen, chunkBytes); reject any
	// padded/short count before walking the array.
	if (m.chunks.length !== chunkCount(m.totalRawLen, m.chunkBytes)) return null;
	const chunks: AssetChunkRef[] = [];
	let sumRaw = 0;
	for (const raw of m.chunks) {
		if (!raw || typeof raw !== "object") return null;
		const c = raw as Record<string, unknown>;
		if (typeof c.hash !== "string" || !/^[0-9a-f]{64}$/.test(c.hash)) return null;
		if (typeof c.encLen !== "number" || !Number.isInteger(c.encLen) || c.encLen <= 0) return null;
		if (
			typeof c.rawLen !== "number" ||
			!Number.isInteger(c.rawLen) ||
			c.rawLen < 0 ||
			c.rawLen > m.chunkBytes
		) {
			return null;
		}
		sumRaw += c.rawLen;
		chunks.push({ hash: c.hash, encLen: c.encLen, rawLen: c.rawLen });
	}
	if (sumRaw !== m.totalRawLen) return null;
	const kind = parseManifestKind(m.kind);
	return {
		v: 1,
		assetId: m.assetId,
		mime,
		chunkBytes: m.chunkBytes,
		totalRawLen: m.totalRawLen,
		chunks,
		...(kind !== undefined ? { kind } : {}),
	};
}

/** How many chunks a `rawLen`-byte blob splits into. Always ≥ 1 — a 0-byte
 *  blob is one empty chunk so the manifest is never empty and download
 *  reproduces a 0-byte file. */
export function chunkCount(rawLen: number, chunkBytes: number = ASSET_CHUNK_BYTES): number {
	if (chunkBytes <= 0) throw new Error("chunkCount: chunkBytes must be > 0");
	return Math.max(1, Math.ceil(rawLen / chunkBytes));
}

/** Seal one plaintext chunk under `dek`, AAD-bound to `(assetId, index)`, and
 *  return its sealed bytes + manifest ref (content address). */
export function sealOneChunk(
	raw: Uint8Array,
	dek: Uint8Array,
	assetId: string,
	index: number,
): { ref: AssetChunkRef; enc: Uint8Array } {
	const nonce = chunkNonce(dek, assetId, index, raw);
	const enc = sealBytesWithNonce(dek, nonce, raw, chunkAad(assetId, index));
	const hash = sha256Hex(enc);
	return { ref: { hash, encLen: enc.length, rawLen: raw.length }, enc };
}

/** Open one sealed chunk, verifying its content address + plaintext length
 *  against `ref` before and after the AEAD open. Throws on an address mismatch
 *  (tamper / wrong bytes), an AEAD failure (wrong key / tampered ciphertext),
 *  or a length mismatch. */
export function openOneChunk(
	enc: Uint8Array,
	dek: Uint8Array,
	assetId: string,
	index: number,
	ref: AssetChunkRef,
): Uint8Array {
	if (sha256Hex(enc) !== ref.hash) {
		throw new Error(`openOneChunk: chunk ${index} content-address mismatch`);
	}
	const raw = openBytes(dek, enc, chunkAad(assetId, index));
	if (raw.length !== ref.rawLen) {
		throw new Error(`openOneChunk: chunk ${index} length ${raw.length} != manifest ${ref.rawLen}`);
	}
	return raw;
}

/**
 * Whole-blob convenience: split `plaintext` into `chunkBytes` chunks, seal each
 * under `dek`, and return the manifest + the sealed chunks keyed by content
 * address. Holds every sealed chunk in memory — for SMALL assets + tests; the
 * transport streams via `sealOneChunk` for large blobs.
 */
export function sealAssetChunks(
	plaintext: Uint8Array,
	dek: Uint8Array,
	assetId: string,
	mime: string,
	chunkBytes: number = ASSET_CHUNK_BYTES,
	kind?: AssetKind,
): { manifest: AssetChunkManifest; sealed: Map<string, Uint8Array> } {
	const count = chunkCount(plaintext.length, chunkBytes);
	const chunks: AssetChunkRef[] = [];
	const sealed = new Map<string, Uint8Array>();
	for (let i = 0; i < count; i += 1) {
		const start = i * chunkBytes;
		const raw = plaintext.subarray(start, Math.min(start + chunkBytes, plaintext.length));
		const { ref, enc } = sealOneChunk(raw, dek, assetId, i);
		chunks.push(ref);
		sealed.set(ref.hash, enc);
	}
	return {
		manifest: {
			v: 1,
			assetId,
			mime,
			chunkBytes,
			totalRawLen: plaintext.length,
			chunks,
			...(kind !== undefined ? { kind } : {}),
		},
		sealed,
	};
}

/**
 * Whole-blob convenience: reassemble a blob from its manifest, fetching each
 * sealed chunk via `getChunk(hash)`. Verifies every chunk's content address +
 * length and the total reassembled size. Returns the full plaintext buffer —
 * for SMALL assets + tests; the transport streams chunk-by-chunk to a file.
 */
export async function openAssetChunks(
	manifest: AssetChunkManifest,
	dek: Uint8Array,
	getChunk: (hash: string) => Promise<Uint8Array | null>,
): Promise<Uint8Array> {
	if (manifest.v !== 1) {
		throw new Error(`openAssetChunks: unsupported manifest v=${String(manifest.v)}`);
	}
	const out = new Uint8Array(manifest.totalRawLen);
	let offset = 0;
	for (let i = 0; i < manifest.chunks.length; i += 1) {
		const ref = manifest.chunks[i];
		if (!ref) throw new Error(`openAssetChunks: missing manifest entry ${i}`);
		const enc = await getChunk(ref.hash);
		if (!enc) throw new Error(`openAssetChunks: chunk ${i} (${ref.hash}) not found`);
		const raw = openOneChunk(enc, dek, manifest.assetId, i, ref);
		out.set(raw, offset);
		offset += raw.length;
	}
	if (offset !== manifest.totalRawLen) {
		throw new Error(`openAssetChunks: reassembled ${offset} != manifest ${manifest.totalRawLen}`);
	}
	return out;
}
