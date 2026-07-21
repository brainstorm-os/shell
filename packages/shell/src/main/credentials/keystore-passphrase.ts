/**
 * PassphraseBackend — fallback when no OS keystore is available.
 *
 * Per §Fallback chain:
 *
 *   The vault master key is held only in memory; on vault-open the user
 *   enters a passphrase, an Argon2id-derived key decrypts the master key
 *   from a vault-stored ciphertext. The master key is held in memory until
 *   vault close.
 *
 * Architecture (this backend wraps individual Tier-1 items, not just the
 * master key — so the same fallback works for the identity private key too):
 *
 *   1. The backend owns a 32-byte "wrap key" derived from the passphrase via
 *      Argon2id (m=64 MiB, t=3, p=4 per OQ-114 resolution).
 *   2. Each stored secret is XChaCha20-Poly1305-encrypted under the wrap key
 *      with a fresh 24-byte random nonce.
 *   3. The wrap blob at <vault>/shell/passphrase-wrap.json records:
 *      - Argon2id parameters used (m, t, p) — so old vaults stay openable
 *        when defaults change.
 *      - Per-secret nonce + ciphertext.
 *      - A passphrase verifier (so wrong passphrases fail fast and clearly).
 *
 * Stage 2 wires this backend but does NOT ship a passphrase-entry UI; that
 * arrives alongside the settings panel proper in a later stage. Tests and
 * the headless CLI consume the backend programmatically via `openOrCreate`.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	argon2idDerive,
	xchacha20Poly1305Open,
	xchacha20Poly1305Seal,
} from "@brainstorm-os/native";
import { base64ToBytes, bytesToBase64 } from "./crypto";
import type { KeystoreAccount, KeystoreBackend, KeystoreBackendName } from "./keystore";
import { PASSPHRASE_WRAP_FILENAME } from "./keystore-insecure";

const EMPTY_AAD = new Uint8Array(0);

/** OQ-114 resolution — OWASP 2024 first-recommended interactive Argon2id profile. */
export const ARGON2_DEFAULTS = {
	m: 65536, // 64 MiB
	t: 3,
	p: 4,
} as const;

const SALT_BYTES = 16;
const NONCE_BYTES = 24; // XChaCha20-Poly1305 nonce
const WRAP_KEY_BYTES = 32;
const VERIFIER_PLAINTEXT = new TextEncoder().encode("brainstorm-passphrase-verifier-v1");

export type PassphraseSecrets = {
	/** Plain-text passphrase the user typed. The backend never persists this. */
	passphrase: string;
	/**
	 * Optional override of the Argon2id cost parameters. Production uses
	 * `ARGON2_DEFAULTS` (OWASP 2024 first-recommended profile). Tests pass a
	 * lighter profile to avoid spending 64 MiB × multiple seconds per case.
	 * Whatever is passed here is persisted in the wrap file so the same
	 * derivation runs on every open.
	 */
	kdf?: { m: number; t: number; p: number };
};

type WrapFile = {
	v: 1;
	kdf: {
		algo: "argon2id";
		m: number;
		t: number;
		p: number;
		saltB64: string;
	};
	verifierB64: string; // ciphertext of VERIFIER_PLAINTEXT, used for wrong-passphrase detection
	verifierNonceB64: string;
	secrets: Record<string, { nonceB64: string; ciphertextB64: string }>;
};

export class PassphraseBackend implements KeystoreBackend {
	readonly name: KeystoreBackendName = "passphrase";
	readonly description = "Passphrase-protected (Argon2id + XChaCha20-Poly1305)";
	readonly isInsecure = false;
	readonly isPersistent = true;

	private readonly filePath: string;
	private wrapKey: Uint8Array;
	private file: WrapFile;

	private constructor(filePath: string, wrapKey: Uint8Array, file: WrapFile) {
		this.filePath = filePath;
		this.wrapKey = wrapKey;
		this.file = file;
	}

	static async openOrCreate(
		vaultPath: string,
		secrets: PassphraseSecrets,
	): Promise<PassphraseBackend> {
		const filePath = join(vaultPath, "shell", PASSPHRASE_WRAP_FILENAME);
		const existing = await tryReadFile(filePath);

		if (existing) {
			const wrapKey = await deriveWrapKey(secrets.passphrase, existing.kdf);
			assertVerifier(wrapKey, existing);
			return new PassphraseBackend(filePath, wrapKey, existing);
		}

		// Fresh vault — create the wrap file.
		const salt = randomBytes(SALT_BYTES);
		const params = secrets.kdf ?? ARGON2_DEFAULTS;
		const kdf = {
			algo: "argon2id" as const,
			m: params.m,
			t: params.t,
			p: params.p,
			saltB64: bytesToBase64(salt),
		};
		const wrapKey = await deriveWrapKey(secrets.passphrase, kdf);
		const verifierNonce = randomBytes(NONCE_BYTES);
		const verifierCipher = xchacha20Poly1305Seal(
			wrapKey,
			verifierNonce,
			VERIFIER_PLAINTEXT,
			EMPTY_AAD,
		);
		const file: WrapFile = {
			v: 1,
			kdf,
			verifierB64: bytesToBase64(verifierCipher),
			verifierNonceB64: bytesToBase64(verifierNonce),
			secrets: {},
		};
		const backend = new PassphraseBackend(filePath, wrapKey, file);
		await backend.persist();
		return backend;
	}

	async setSecret(vaultId: string, account: KeystoreAccount, secret: Uint8Array): Promise<void> {
		const nonce = randomBytes(NONCE_BYTES);
		const ciphertext = xchacha20Poly1305Seal(this.wrapKey, nonce, secret, EMPTY_AAD);
		this.file.secrets[`${vaultId}.${account}`] = {
			nonceB64: bytesToBase64(nonce),
			ciphertextB64: bytesToBase64(ciphertext),
		};
		await this.persist();
	}

	async getSecret(vaultId: string, account: KeystoreAccount): Promise<Uint8Array | null> {
		const entry = this.file.secrets[`${vaultId}.${account}`];
		if (!entry) return null;
		const nonce = base64ToBytes(entry.nonceB64);
		const ciphertext = base64ToBytes(entry.ciphertextB64);
		return xchacha20Poly1305Open(this.wrapKey, nonce, ciphertext, EMPTY_AAD);
	}

	async deleteSecret(vaultId: string, account: KeystoreAccount): Promise<boolean> {
		const key = `${vaultId}.${account}`;
		if (!(key in this.file.secrets)) return false;
		delete this.file.secrets[key];
		await this.persist();
		return true;
	}

	/** Erase the in-memory wrap key. Call when the vault closes. */
	dispose(): void {
		this.wrapKey.fill(0);
		this.wrapKey = new Uint8Array(0);
	}

	private async persist(): Promise<void> {
		await mkdir(dirname(this.filePath), { recursive: true });
		await writeFile(this.filePath, `${JSON.stringify(this.file, null, 2)}\n`, "utf8");
	}
}

async function tryReadFile(filePath: string): Promise<WrapFile | null> {
	try {
		const raw = await readFile(filePath, "utf8");
		const parsed = JSON.parse(raw) as Partial<WrapFile>;
		if (!isWrapFile(parsed)) {
			throw new Error("passphrase-wrap.json is malformed");
		}
		return parsed;
	} catch (error) {
		if (isNotFound(error)) return null;
		throw error;
	}
}

function isWrapFile(value: Partial<WrapFile> | null): value is WrapFile {
	if (!value || typeof value !== "object") return false;
	return (
		value.v === 1 &&
		value.kdf != null &&
		value.kdf.algo === "argon2id" &&
		typeof value.kdf.m === "number" &&
		typeof value.kdf.t === "number" &&
		typeof value.kdf.p === "number" &&
		typeof value.kdf.saltB64 === "string" &&
		typeof value.verifierB64 === "string" &&
		typeof value.verifierNonceB64 === "string" &&
		!!value.secrets &&
		typeof value.secrets === "object"
	);
}

async function deriveWrapKey(passphrase: string, kdf: WrapFile["kdf"]): Promise<Uint8Array> {
	const salt = base64ToBytes(kdf.saltB64);
	const passphraseBytes = new TextEncoder().encode(passphrase);
	return new Uint8Array(argon2idDerive(passphraseBytes, salt, kdf.m, kdf.t, kdf.p, WRAP_KEY_BYTES));
}

function assertVerifier(wrapKey: Uint8Array, file: WrapFile): void {
	const nonce = base64ToBytes(file.verifierNonceB64);
	const ciphertext = base64ToBytes(file.verifierB64);
	try {
		const plaintext = xchacha20Poly1305Open(wrapKey, nonce, ciphertext, EMPTY_AAD);
		const expected = VERIFIER_PLAINTEXT;
		if (plaintext.length !== expected.length) throw new Error("verifier length mismatch");
		for (let i = 0; i < expected.length; i++) {
			if (plaintext[i] !== expected[i]) throw new Error("verifier mismatch");
		}
	} catch {
		throw new Error("Incorrect passphrase");
	}
}

function isNotFound(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code: unknown }).code === "ENOENT"
	);
}
