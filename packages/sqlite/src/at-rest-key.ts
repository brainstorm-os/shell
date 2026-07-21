/**
 * Stage 3b — per-DB at-rest encryption key derivation.
 *
 * Each of the four domain databases (`ledger` / `registry` / `entities` /
 * `search`) is encrypted under its OWN key so that a leak of one DB's key
 * (or a future per-DB rekey) never compromises the others. Every per-DB key
 * is derived deterministically from the vault's 32-byte master key via
 * HKDF-SHA256 (the native `hkdfSha256` binding) with a per-DB `info` string. The
 * master key itself never touches disk, IPC, or a log line; the derived keys
 * are equally sensitive and are zeroed by the caller after `PRAGMA key`.
 *
 * This is the same master-key → subkey shape the credential layer uses
 * (`main/credentials/`): one long-lived secret in the keystore, purpose-bound
 * subkeys derived on demand. We do NOT invent a new KDF — HKDF-SHA256 with a
 * domain-separated info string is the standard construction for exactly this.
 *
 * The `info` string is the encryption *domain separator*. It is versioned
 * (`v1`) so a future key-rotation can derive a fresh key under a new info
 * string without colliding with the v1 key.
 */

import { hkdfSha256 } from "@brainstorm-os/native";

/** The four domain DBs whose at-rest keys we derive. Mirrors
 *  `DataStoreKind` in `data-stores.ts`; kept as an enum so the info-string
 *  domain separators are referenced by name, never a bare literal. */
export enum AtRestDb {
	Ledger = "ledger",
	Registry = "registry",
	Entities = "entities",
	Search = "search",
	Settings = "settings",
	Cookies = "cookies",
	Account = "account",
}

/** Derived raw key length. 32 bytes = SQLCipher's 256-bit AES key. */
export const AT_REST_KEY_BYTES = 32;

/** HKDF salt. A fixed, non-secret application-domain salt is correct for
 *  HKDF when the input keying material (the master key) is already a
 *  high-entropy uniform random key — RFC 5869 §3.1. Domain separation is
 *  carried by the per-DB `info` string, not the salt. */
const AT_REST_HKDF_SALT = new TextEncoder().encode("brainstorm/at-rest/hkdf/v1");

/** Info / domain-separation string for a given DB. Versioned so a future
 *  rotation derives a distinct key without colliding with v1. */
export function atRestInfoString(db: AtRestDb): string {
	return `${db}.db at-rest v1`;
}

/**
 * Derive the 32-byte at-rest key for `db` from the vault master key.
 *
 * Deterministic: same master key + same db ⇒ same key (required so a
 * returning user can reopen their vault). Distinct per db (domain-separated
 * info). The returned buffer is freshly allocated and MUST be zeroed by the
 * caller once issued to the driver (`zeroKey`).
 */
export function deriveAtRestKey(masterKey: Uint8Array, db: AtRestDb): Uint8Array {
	if (!(masterKey instanceof Uint8Array) || masterKey.length !== AT_REST_KEY_BYTES) {
		throw new Error(`deriveAtRestKey: master key must be a ${AT_REST_KEY_BYTES}-byte Uint8Array`);
	}
	const info = new TextEncoder().encode(atRestInfoString(db));
	return new Uint8Array(hkdfSha256(masterKey, AT_REST_HKDF_SALT, info, AT_REST_KEY_BYTES));
}

/** Lowercase hex of a key. The driver's raw-key form is `x'<hex>'`; callers
 *  that build the `PRAGMA key` / `PRAGMA rekey` string wrap this. */
export function keyToHex(key: Uint8Array): string {
	let hex = "";
	for (const b of key) hex += b.toString(16).padStart(2, "0");
	return hex;
}

/** Best-effort zeroing of derived key material. Call once the key has been
 *  handed to the driver via `PRAGMA key`. */
export function zeroKey(key: Uint8Array): void {
	for (let i = 0; i < key.length; i++) key[i] = 0;
}
