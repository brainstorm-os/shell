/**
 * At-rest encryption for vault-local MEDIA blobs (OQ-240) — user-uploaded
 * covers, icons, and wallpaper images.
 *
 * These were the last plaintext-on-disk binary stores: their metadata
 * (entity properties, dashboard doc) is encrypted, but the image bytes sat in
 * the clear at `<vault>/covers|icons|dashboard/wallpapers/`. Everything else
 * the vault writes is ciphertext under the master key (the SQLite DBs, the
 * Yjs docs, the `AssetStore` blobs), so these broke at-rest parity.
 *
 * Unlike the `AssetStore` (random per-asset DEKs, for blind-sync blobs), these
 * stay **content-addressed** (`<sha256>.<ext>`) and local-only, so a single
 * deterministic media key derived from the master key (HKDF, the same shape as
 * the per-DB at-rest keys) is the right fit — no DEK table, URL scheme, or
 * consumer unchanged. A blob is `MAGIC || sealBytes(nonce||ciphertext)`; the
 * 4-byte magic lets a reader serve new ciphertext or a legacy plaintext image
 * without a decrypt-probe, and makes the one-time re-seal migration idempotent.
 * AAD binds each blob to its `<domain>:<filename>` so a cover can't be served
 * in place of an icon.
 */

import { hkdfSha256 } from "@brainstorm-os/native";
import { openBytes, sealBytes } from "../credentials/crypto";

/** Domains of vault media blobs. The value is BOTH the on-disk subdirectory
 *  (relative to the vault root) and the AAD domain separator. */
export enum VaultMediaDomain {
	Cover = "covers",
	Icon = "icons",
	Wallpaper = "dashboard/wallpapers",
}

/** Encrypts a media blob for at-rest storage, bound to a domain by the caller.
 *  The upload cores take one of these; tests omit it (plaintext, which the
 *  open-time migration re-seals). */
export type MediaSeal = (relName: string, bytes: Uint8Array) => Uint8Array;

/** 4-byte magic ("BSM1") prefixing a sealed media blob. No raster/vector image
 *  magic (PNG `\x89PNG`, JPEG `\xFF\xD8`, WebP `RIFF`, GIF `GIF8`, SVG `<`,
 *  AVIF ftyp) collides with it, so a plaintext legacy file is unambiguously
 *  distinguishable from ciphertext. */
export const MEDIA_SEAL_MAGIC = new Uint8Array([0x42, 0x53, 0x4d, 0x31]);

const MEDIA_HKDF_SALT = new TextEncoder().encode("brainstorm/at-rest/hkdf/v1");
const MEDIA_HKDF_INFO = new TextEncoder().encode("vault media at-rest v1");
const MEDIA_KEY_BYTES = 32;

/** Derive the deterministic 32-byte media at-rest key from the vault master
 *  key. Same HKDF construction as the per-DB at-rest keys, with its own info
 *  string (domain separation from the DB keys). */
export function deriveMediaKey(masterKey: Uint8Array): Uint8Array {
	return new Uint8Array(hkdfSha256(masterKey, MEDIA_HKDF_SALT, MEDIA_HKDF_INFO, MEDIA_KEY_BYTES));
}

/** True when `blob` carries the sealed-media magic (i.e. is ciphertext, not a
 *  legacy plaintext image). */
export function isSealedMedia(blob: Uint8Array): boolean {
	if (blob.length < MEDIA_SEAL_MAGIC.length) return false;
	for (let i = 0; i < MEDIA_SEAL_MAGIC.length; i++) {
		if (blob[i] !== MEDIA_SEAL_MAGIC[i]) return false;
	}
	return true;
}

function mediaAad(domain: VaultMediaDomain, relName: string): Uint8Array {
	return new TextEncoder().encode(`brainstorm/media/v1:${domain}:${relName}`);
}

/** Seal `plaintext` for `domain`/`relName`: `MAGIC || nonce || ciphertext`. */
export function sealMedia(
	key: Uint8Array,
	domain: VaultMediaDomain,
	relName: string,
	plaintext: Uint8Array,
): Uint8Array {
	const ciphertext = sealBytes(key, plaintext, mediaAad(domain, relName));
	const out = new Uint8Array(MEDIA_SEAL_MAGIC.length + ciphertext.length);
	out.set(MEDIA_SEAL_MAGIC, 0);
	out.set(ciphertext, MEDIA_SEAL_MAGIC.length);
	return out;
}

/** Open a sealed media blob. Throws if `blob` lacks the magic (a caller that
 *  has already gated on {@link isSealedMedia} won't hit that), on a wrong key,
 *  wrong AAD (domain/filename mismatch), or tampering. */
export function openMedia(
	key: Uint8Array,
	domain: VaultMediaDomain,
	relName: string,
	blob: Uint8Array,
): Uint8Array {
	if (!isSealedMedia(blob)) {
		throw new Error("openMedia: not a sealed media blob");
	}
	return openBytes(key, blob.subarray(MEDIA_SEAL_MAGIC.length), mediaAad(domain, relName));
}
