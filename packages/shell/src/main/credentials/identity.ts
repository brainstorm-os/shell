/**
 * Sovereign identity per.
 *
 *   Every vault gets an Ed25519 keypair on first launch. The private key
 *   never leaves the main process — apps that need signing call
 *   `identity.signPayload` and receive a signature, not the key.
 *
 * Stage 2 scope: generate, sign, verify, fingerprint. Multi-device pairing
 * (where the user key is shared across paired devices via key exchange)
 * arrives in Stage 10.
 *
 * Fingerprint format: `ed25519:<lowercase-hex-of-first-8-bytes-of-sha256>` —
 * a short identifier surfaced in the UI (vault list, sharing dialogs) so
 * users can recognize a key without seeing the full base64 blob.
 */

import { randomBytes } from "node:crypto";
import { ed25519GetPublicKey, ed25519Sign, ed25519Verify, sha256 } from "@brainstorm-os/native";
import {
	assertSecret as assertSecretLen,
	publicKeyFromBase64 as publicKeyFromBase64Len,
	publicKeyToBase64 as publicKeyToBase64Len,
} from "./key-codec";

export const ED25519_SECRET_BYTES = 32;
export const ED25519_PUBLIC_BYTES = 32;
export const ED25519_SIGNATURE_BYTES = 64;

export type IdentityKeypair = {
	secretKey: Uint8Array; // 32 bytes
	publicKey: Uint8Array; // 32 bytes
};

export function generateIdentity(): IdentityKeypair {
	const secretKey = new Uint8Array(randomBytes(ED25519_SECRET_BYTES));
	const publicKey = new Uint8Array(ed25519GetPublicKey(secretKey));
	return { secretKey, publicKey };
}

export function publicKeyFromSecret(secretKey: Uint8Array): Uint8Array {
	assertSecret(secretKey);
	return new Uint8Array(ed25519GetPublicKey(secretKey));
}

export function signPayload(secretKey: Uint8Array, payload: Uint8Array): Uint8Array {
	assertSecret(secretKey);
	return new Uint8Array(ed25519Sign(secretKey, payload));
}

export function verifySignature(
	publicKey: Uint8Array,
	payload: Uint8Array,
	signature: Uint8Array,
): boolean {
	if (publicKey.length !== ED25519_PUBLIC_BYTES) return false;
	if (signature.length !== ED25519_SIGNATURE_BYTES) return false;
	return ed25519Verify(publicKey, payload, signature);
}

/** Short identifier suitable for display: `ed25519:<16-hex-chars>` (first 8 bytes of SHA-256). */
export function fingerprintPublicKey(publicKey: Uint8Array): string {
	if (publicKey.length !== ED25519_PUBLIC_BYTES) {
		throw new Error("fingerprintPublicKey: public key must be 32 bytes");
	}
	const digest = sha256(publicKey);
	const head = digest.slice(0, 8);
	const hex = Array.from(head)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `ed25519:${hex}`;
}

export function publicKeyToBase64(publicKey: Uint8Array): string {
	return publicKeyToBase64Len(publicKey, ED25519_PUBLIC_BYTES);
}

export function publicKeyFromBase64(encoded: string): Uint8Array {
	return publicKeyFromBase64Len(encoded, ED25519_PUBLIC_BYTES);
}

function assertSecret(secretKey: Uint8Array): void {
	assertSecretLen(secretKey, ED25519_SECRET_BYTES);
}
