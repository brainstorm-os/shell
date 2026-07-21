/**
 * Stage 3b — transparent plaintext → encrypted upgrade for existing vaults.
 *
 * Vaults created before Stage 3b have plaintext DB files. When the encrypted
 * driver is active we must NOT brick or lose that data: on first open we
 * detect a plaintext file and rekey it to an encrypted file under the
 * derived at-rest key, in place, atomically and idempotently.
 *
 * Strategy (in-place `PRAGMA rekey` on an isolated copy — the data-lossless
 * path the active driver actually supports):
 *
 *   1. Open the existing file with NO key.
 *   2. If `SELECT count(*) FROM sqlite_master` succeeds → it is plaintext and
 *      needs migration. If it raises "file is not a database" → it is already
 *      encrypted (or empty-but-keyed); nothing to do (idempotent).
 *   3. `copyFile(<path>, <tmp>)` — work on a copy so the plaintext original is
 *      never mutated until the final atomic rename.
 *   4. Open `<tmp>` with NO key and issue `PRAGMA rekey = "x'<hex>'"`.
 *      SQLite3MultipleCiphers encrypts a plaintext database in place on rekey.
 *   5. Fail-closed verification: the keyed connection must still read
 *      `sqlite_master`, AND a fresh NO-key open of `<tmp>` must now fail to
 *      read it (proof it is genuinely encrypted, not a silent no-op).
 *   6. `rename(<tmp>, <path>)` — POSIX atomic same-dir replace. Either the
 *      old plaintext file or the fully-migrated encrypted file is at `<path>`
 *      at every instant; a crash at any point leaves the plaintext original
 *      untouched and the temp file orphaned (cleaned on the next attempt).
 *
 * `better-sqlite3-multiple-ciphers` is SQLite3MultipleCiphers, which does NOT
 * ship SQLCipher's `sqlcipher_export()` extension function — the earlier
 * ATTACH + `sqlcipher_export` strategy failed at runtime with "no such
 * function: sqlcipher_export". `PRAGMA rekey` is the supported, data-lossless
 * in-place encryption path. The detection + atomic-rename + idempotence logic
 * is driver-independent and fully unit-tested via an injectable fake.
 */

import { existsSync } from "node:fs";
import { copyFile, rename, rm } from "node:fs/promises";
import { keyToHex } from "./at-rest-key";

/** Minimal raw-handle surface the migration needs from a SQLCipher driver.
 *  Deliberately NOT the wrapped `SqliteDatabase` — migration runs before the
 *  app-facing handle exists and needs un-pragma'd exec/get. */
export interface SqlcipherRawHandle {
	exec(sql: string): void;
	/** Returns the first row, or throws if the statement itself errors
	 *  (e.g. reading an encrypted file with no/wrong key → "file is not a
	 *  database"). */
	probe(sql: string): unknown;
	close(): void;
}

export type RawOpener = (path: string) => SqlcipherRawHandle;

export enum AtRestState {
	/** File absent — a brand-new DB; opener will create it keyed. */
	Absent = "absent",
	/** File present and readable with NO key — legacy plaintext. */
	Plaintext = "plaintext",
	/** File present, NOT readable without a key — already encrypted. */
	Encrypted = "encrypted",
}

/**
 * Classify an on-disk DB file WITHOUT mutating it. Opens with no key and
 * probes `sqlite_master`. Readable ⇒ plaintext; throws ⇒ encrypted.
 */
export function classifyAtRest(path: string, openRaw: RawOpener): AtRestState {
	if (!existsSync(path)) return AtRestState.Absent;
	const h = openRaw(path);
	try {
		h.probe("SELECT count(*) AS n FROM sqlite_master");
		return AtRestState.Plaintext;
	} catch {
		return AtRestState.Encrypted;
	} finally {
		try {
			h.close();
		} catch {
			/* a handle that failed to read may also fail to close cleanly */
		}
	}
}

/** Path of the scratch file we export into before the atomic rename. */
export function migrationTempPath(path: string): string {
	return `${path}.encrypting`;
}

/**
 * Migrate a single plaintext DB file to encrypted-at-rest under `rawKey`
 * (issued to the driver as the `x'<hex>'` raw-key literal). Idempotent: a
 * call on an already-encrypted or absent file is a no-op and returns the
 * unchanged state. Atomic: `<path>` only ever holds a complete file.
 *
 * Returns the state the file was in *before* this call.
 */
export async function migratePlaintextToEncrypted(
	path: string,
	rawKey: Uint8Array,
	openRaw: RawOpener,
): Promise<AtRestState> {
	const before = classifyAtRest(path, openRaw);
	if (before !== AtRestState.Plaintext) return before;

	const tmp = migrationTempPath(path);
	// A temp file here is debris from a previously-crashed attempt; the
	// source plaintext file is still intact, so discard the partial.
	if (existsSync(tmp)) await rm(tmp, { force: true });

	// Work on a copy: the plaintext original is never touched until the final
	// atomic rename, so a crash at any step leaves a readable DB at `<path>`.
	await copyFile(path, tmp);

	const keyHex = keyToHex(rawKey);
	try {
		const enc = openRaw(tmp);
		try {
			// SQLite3MultipleCiphers encrypts a plaintext database in place
			// when rekeyed on a no-key connection. The x'<hex>' blob literal
			// is the raw-key form (no driver-side KDF re-hash).
			enc.exec(`PRAGMA rekey = "x'${keyHex}'"`);
			// Fail-closed: the just-keyed connection must still read.
			enc.probe("SELECT count(*) AS n FROM sqlite_master");
		} finally {
			enc.close();
		}
		// Independent proof `<tmp>` is genuinely encrypted now: a fresh
		// NO-key open must fail to read it. A still-readable file means the
		// rekey was a silent no-op — abort, leaving the original intact.
		if (classifyAtRest(tmp, openRaw) !== AtRestState.Encrypted) {
			throw new Error(
				"at-rest migration: PRAGMA rekey did not encrypt the database (driver lacks SQLCipher rekey support)",
			);
		}
	} catch (error) {
		await rm(tmp, { force: true });
		throw error;
	}

	// Atomic same-directory replace. Until this returns, `<path>` is the
	// untouched plaintext original; after it, the encrypted file.
	await rename(tmp, path);
	return before;
}
