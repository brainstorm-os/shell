/**
 * App-lock PIN verifier (Stage 13.8). The PIN is a **gate**, never a KDF for
 * the master key (OQ-184): a 4–6 digit PIN is ~13–20 bits and offline-brute-
 * forceable, so the master key's real protection stays the high-entropy
 * keystore-held secret. This module only proves "the right PIN was entered"
 * via a light-tier Argon2id hash, stored as a keystore secret
 * (`brainstorm.<vaultId>.app-lock-pin`) so it's readable while the master key
 * is zeroed (the verify gates re-reading the key).
 *
 * Crypto routing: lives under `main/credentials/` (the only place allowed to
 * touch the Argon2id binding + keystore), per CLAUDE.md.
 */

import { randomBytes } from "node:crypto";
import { argon2idDerive } from "@brainstorm-os/native";
import { base64ToBytes, bytesToBase64 } from "./crypto";
import type { KeystoreBackend } from "./keystore";

/** Light-tier Argon2id — a recognized OWASP profile (19 MiB / t=2 / p=1),
 *  ~tens of ms. Heavier than necessary against a low-entropy PIN (the keystore
 *  holds the real secret) but cheap enough that unlock stays imperceptible, and
 *  it slows online/offline PIN guessing of the on-disk verifier blob. */
const PIN_KDF = Object.freeze({ m: 19_456, t: 2, p: 1 });
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const PIN_ACCOUNT = "app-lock-pin" as const;

type PinVerifierBlob = {
	readonly algo: "argon2id";
	readonly m: number;
	readonly t: number;
	readonly p: number;
	readonly saltB64: string;
	readonly hashB64: string;
};

/** Constant-time byte comparison — avoids leaking, via timing, how many
 *  leading bytes of the derived hash matched. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
	return diff === 0;
}

function deriveHash(pin: string, salt: Uint8Array, m: number, t: number, p: number): Uint8Array {
	const pinBytes = new TextEncoder().encode(pin);
	const hash = new Uint8Array(argon2idDerive(pinBytes, salt, m, t, p, HASH_BYTES));
	pinBytes.fill(0);
	return hash;
}

function isPinVerifierBlob(value: unknown): value is PinVerifierBlob {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		v.algo === "argon2id" &&
		typeof v.m === "number" &&
		typeof v.t === "number" &&
		typeof v.p === "number" &&
		typeof v.saltB64 === "string" &&
		typeof v.hashB64 === "string"
	);
}

/** Set (or replace) the app-lock PIN. Derives a fresh-salt light-Argon2id hash
 *  and stores the verifier blob in the keystore. */
export async function setAppLockPin(
	backend: KeystoreBackend,
	vaultId: string,
	pin: string,
): Promise<void> {
	const salt = new Uint8Array(randomBytes(SALT_BYTES));
	const hash = deriveHash(pin, salt, PIN_KDF.m, PIN_KDF.t, PIN_KDF.p);
	const blob: PinVerifierBlob = {
		algo: "argon2id",
		m: PIN_KDF.m,
		t: PIN_KDF.t,
		p: PIN_KDF.p,
		saltB64: bytesToBase64(salt),
		hashB64: bytesToBase64(hash),
	};
	const bytes = new TextEncoder().encode(JSON.stringify(blob));
	await backend.setSecret(vaultId, PIN_ACCOUNT, bytes);
}

/** Verify a candidate PIN against the stored verifier. Returns `false` when no
 *  PIN is set or the blob is malformed — never throws on a wrong PIN. Re-derives
 *  with the *stored* params so an older blob keeps verifying after a profile bump. */
export async function verifyAppLockPin(
	backend: KeystoreBackend,
	vaultId: string,
	pin: string,
): Promise<boolean> {
	const bytes = await backend.getSecret(vaultId, PIN_ACCOUNT);
	if (bytes === null) return false;
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return false;
	}
	if (!isPinVerifierBlob(parsed)) return false;
	const candidate = deriveHash(pin, base64ToBytes(parsed.saltB64), parsed.m, parsed.t, parsed.p);
	return timingSafeEqual(candidate, base64ToBytes(parsed.hashB64));
}

/** Whether an app-lock PIN is set for this vault. */
export async function hasAppLockPin(backend: KeystoreBackend, vaultId: string): Promise<boolean> {
	return (await backend.getSecret(vaultId, PIN_ACCOUNT)) !== null;
}

/** Remove the app-lock PIN. Returns whether a PIN was present. */
export async function clearAppLockPin(backend: KeystoreBackend, vaultId: string): Promise<boolean> {
	return backend.deleteSecret(vaultId, PIN_ACCOUNT);
}
