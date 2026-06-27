/**
 * Symmetric encryption helpers used by the credential store (Stage 2) and
 * later by entity DEK encryption (Stage 10).
 *
 * Cipher per OQ-25 resolution: **XChaCha20-Poly1305** via `@brainstorm/native`.
 *   - 256-bit key
 *   - 192-bit nonce (extended) — random nonces are safe against birthday-style
 *     collisions in any realistic Brainstorm vault.
 *   - Authenticated (Poly1305 tag) — tampering detected on decrypt.
 *
 * Wire format (`SealedSecret`):
 *
 *   { v: 1, nonceB64, ciphertextB64 }
 *
 * The ciphertext concatenates the Poly1305 tag (16 bytes appended by
 * `xchacha20Poly1305Seal`). AAD is optional and used at higher layers
 * to bind ciphertext to a context (e.g. an entity id, a credential key).
 */

import { randomBytes } from "node:crypto";
import { xchacha20Poly1305Open, xchacha20Poly1305Seal } from "@brainstorm/native";

const EMPTY_AAD = new Uint8Array(0);

export const SECRET_VERSION = 1 as const;
export const XCHACHA_KEY_BYTES = 32;
export const XCHACHA_NONCE_BYTES = 24;

export type SealedSecret = {
	v: typeof SECRET_VERSION;
	nonceB64: string;
	ciphertextB64: string;
};

export function isSealedSecret(value: unknown): value is SealedSecret {
	if (!value || typeof value !== "object") return false;
	const s = value as Partial<SealedSecret>;
	return (
		s.v === SECRET_VERSION && typeof s.nonceB64 === "string" && typeof s.ciphertextB64 === "string"
	);
}

/**
 * Encrypt `plaintext` under `key`. A fresh random 24-byte nonce is generated
 * per call. Optional `aad` (associated data) is authenticated but not
 * encrypted — useful for binding ciphertext to a key/context.
 */
export function sealSecret(key: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): SealedSecret {
	assertKey(key);
	const nonce = randomNonce();
	const ciphertext = xchacha20Poly1305Seal(key, nonce, plaintext, aad ?? EMPTY_AAD);
	return {
		v: SECRET_VERSION,
		nonceB64: bytesToBase64(nonce),
		ciphertextB64: bytesToBase64(ciphertext),
	};
}

/**
 * Decrypt a sealed secret. Throws on:
 *   - malformed input
 *   - wrong key
 *   - tampered ciphertext (Poly1305 auth tag mismatch)
 *   - wrong AAD (if one was used at seal time)
 */
export function openSecret(key: Uint8Array, sealed: SealedSecret, aad?: Uint8Array): Uint8Array {
	assertKey(key);
	if (!isSealedSecret(sealed)) {
		throw new Error("openSecret: invalid SealedSecret shape");
	}
	const nonce = base64ToBytes(sealed.nonceB64);
	const ciphertext = base64ToBytes(sealed.ciphertextB64);
	if (nonce.length !== XCHACHA_NONCE_BYTES) {
		throw new Error(`openSecret: nonce must be ${XCHACHA_NONCE_BYTES} bytes`);
	}
	return xchacha20Poly1305Open(key, nonce, ciphertext, aad ?? EMPTY_AAD);
}

/**
 * Seal `plaintext` into a self-framed binary blob: `nonce(24) || ciphertext`
 * (the ciphertext carries the appended Poly1305 tag). Unlike `sealSecret`
 * this returns raw bytes, not base64 JSON — the right shape for large
 * payloads (file/asset blobs) where a base64+JSON envelope would bloat the
 * on-disk file by a third. A fresh random nonce is generated per call;
 * `aad` is authenticated but not encrypted (bind to a context, e.g. an
 * asset id).
 */
export function sealBytes(key: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): Uint8Array {
	assertKey(key);
	const nonce = randomNonce();
	const ciphertext = xchacha20Poly1305Seal(key, nonce, plaintext, aad ?? EMPTY_AAD);
	const out = new Uint8Array(nonce.length + ciphertext.length);
	out.set(nonce, 0);
	out.set(ciphertext, nonce.length);
	return out;
}

/**
 * Like {@link sealBytes} but with a CALLER-SUPPLIED nonce, returning the same
 * `nonce(24) || ciphertext` framing so {@link openBytes} reads it unchanged.
 *
 * For deterministic content-addressed sealing (the asset-chunk transport): the
 * nonce is derived from the chunk's content so the same chunk re-seals to the
 * same ciphertext → a stable CAS address, which is what makes resume +
 * skip-already-present work. ⚠️ The caller MUST guarantee a `(key, nonce)` pair
 * is never reused with DIFFERENT plaintext — deriving the nonce from the
 * plaintext (a synthetic IV) ensures this; reuse across distinct plaintext
 * breaks XChaCha20-Poly1305's confidentiality + integrity.
 */
export function sealBytesWithNonce(
	key: Uint8Array,
	nonce: Uint8Array,
	plaintext: Uint8Array,
	aad?: Uint8Array,
): Uint8Array {
	assertKey(key);
	if (!(nonce instanceof Uint8Array) || nonce.length !== XCHACHA_NONCE_BYTES) {
		throw new Error(`sealBytesWithNonce: nonce must be ${XCHACHA_NONCE_BYTES} bytes`);
	}
	const ciphertext = xchacha20Poly1305Seal(key, nonce, plaintext, aad ?? EMPTY_AAD);
	const out = new Uint8Array(nonce.length + ciphertext.length);
	out.set(nonce, 0);
	out.set(ciphertext, nonce.length);
	return out;
}

/**
 * Decrypt a `sealBytes` blob (`nonce(24) || ciphertext`). Throws on a blob
 * too short to carry a nonce, a wrong key, a wrong `aad`, or a tampered
 * ciphertext (Poly1305 tag mismatch).
 */
export function openBytes(key: Uint8Array, blob: Uint8Array, aad?: Uint8Array): Uint8Array {
	assertKey(key);
	if (!(blob instanceof Uint8Array) || blob.length <= XCHACHA_NONCE_BYTES) {
		throw new Error("openBytes: blob too short to contain a nonce + ciphertext");
	}
	const nonce = blob.subarray(0, XCHACHA_NONCE_BYTES);
	const ciphertext = blob.subarray(XCHACHA_NONCE_BYTES);
	return xchacha20Poly1305Open(key, nonce, ciphertext, aad ?? EMPTY_AAD);
}

/** Generate a 32-byte symmetric key. Used for vault master keys and DEKs. */
export function generateSymmetricKey(): Uint8Array {
	return new Uint8Array(randomBytes(XCHACHA_KEY_BYTES));
}

function randomNonce(): Uint8Array {
	return new Uint8Array(randomBytes(XCHACHA_NONCE_BYTES));
}

function assertKey(key: Uint8Array): void {
	if (!(key instanceof Uint8Array) || key.length !== XCHACHA_KEY_BYTES) {
		throw new Error(`key must be a ${XCHACHA_KEY_BYTES}-byte Uint8Array`);
	}
}

export function bytesToBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}

export function base64ToBytes(encoded: string): Uint8Array {
	return new Uint8Array(Buffer.from(encoded, "base64"));
}
