/**
 * HPKE base-mode single-shot Seal/Open (RFC 9180).
 *
 * Cipher suite, pinned for v1 (matches §3.3):
 *   - KEM:  DHKEM(X25519, HKDF-SHA256)   kem_id  = 0x0020
 *   - KDF:  HKDF-SHA256                  kdf_id  = 0x0001
 *   - AEAD: ChaCha20-Poly1305            aead_id = 0x0003
 *
 * NAPI-3d swap: the noble-{curves,hashes,ciphers}-composed implementation
 * was replaced by `hpkeSealBase` / `hpkeOpenBase` in `@brainstorm-os/native`.
 * Public API surface (HPKE_SUITE, SealResult, SealBaseOptions, sealBase,
 * openBase) is unchanged — the existing `hpke.test.ts` parity proof
 * (RFC 9180 A.2.1 KAT + round-trip + negative cases) passes verbatim.
 *
 * Scope: base mode, single-shot SealBase/OpenBase. PSK + auth modes are
 * out of scope (v1 doesn't use them). Multi-shot context is not exposed —
 * member wraps are one-shot encapsulations of a 32-byte DEK; nothing
 * benefits from a long-lived context.
 *
 * The on-wire layout is the caller's responsibility — this module returns
 * `enc` (the ephemeral sender pubkey) and `ct` (ciphertext || tag) and
 * leaves serialisation to the wrap codec.
 */

import { hpkeOpenBase, hpkeSealBase } from "@brainstorm-os/native";

const N_PK = 32;
const N_ENC = 32;

export type SealResult = {
	/** The 32-byte ephemeral sender pubkey (KEM encapsulation). */
	enc: Uint8Array;
	/** ChaCha20-Poly1305 ciphertext concatenated with the 16-byte Poly1305 tag. */
	ct: Uint8Array;
};

export type SealBaseOptions = {
	/** Caller-supplied ephemeral secret. Test-only — production always
	 *  uses a fresh CSPRNG-generated keypair (default). */
	ephemeralSecret?: Uint8Array;
};

/**
 * SealBase per RFC 9180 §6.1. Encapsulates `pt` to `pkR` under the suite
 * (DHKEM(X25519,HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305) using a
 * fresh ephemeral sender keypair. `info` is bound into the KDF and `aad`
 * into the AEAD (both required to open).
 *
 * Returns `(enc, ct)` where `enc` is the 32-byte ephemeral sender pubkey
 * and `ct` is the ciphertext with the 16-byte Poly1305 tag appended.
 */
export function sealBase(
	pkR: Uint8Array,
	info: Uint8Array,
	aad: Uint8Array,
	pt: Uint8Array,
	options: SealBaseOptions = {},
): SealResult {
	if (pkR.length !== N_PK) throw new Error(`hpke: pkR must be ${N_PK} bytes`);
	const result = hpkeSealBase(pkR, info, aad, pt, options.ephemeralSecret);
	return { enc: result.enc, ct: result.ct };
}

/**
 * OpenBase per RFC 9180 §6.1. Inverse of `sealBase`: derives the same
 * shared secret from `(enc, skR)`, runs the same key schedule with `info`,
 * and decrypts `ct` with `aad`. Throws on AEAD tag mismatch (tampered
 * ciphertext, wrong info, wrong aad, wrong recipient key).
 */
export function openBase(
	enc: Uint8Array,
	skR: Uint8Array,
	info: Uint8Array,
	aad: Uint8Array,
	ct: Uint8Array,
): Uint8Array {
	if (enc.length !== N_ENC) throw new Error(`hpke: enc must be ${N_ENC} bytes`);
	if (skR.length !== N_PK) throw new Error(`hpke: skR must be ${N_PK} bytes`);
	return hpkeOpenBase(enc, skR, info, aad, ct);
}

/** Test-only: expose suite constants for cross-checking against the RFC. */
export const HPKE_SUITE = {
	kemId: 0x0020,
	kdfId: 0x0001,
	aeadId: 0x0003,
	nEnc: 32,
	nK: 32,
	nN: 12,
} as const;
