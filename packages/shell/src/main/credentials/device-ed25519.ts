/**
 * Device Ed25519 keypair (Stage 10.5a) — per-device signing key used to sign
 * `add-device` records and pairing-handshake bytes. Sibling to
 * `device-x25519.ts` (HPKE recipient half) and orthogonal to the
 * sovereign-user Ed25519 in `identity.ts`.
 *
 * Three keys, three roles:
 *   - identity.ts (user-Ed25519)  — signs add-device records + envelope headers.
 *   - device-ed25519.ts (this)    — per-device signing key; the pairing
 *                                   protocol uses it to bind handshake bytes
 *                                   to a specific device.
 *   - device-x25519.ts            — per-device HPKE recipient pubkey.
 *
 * Lazy-mints on vault open if absent; persists under keystore account
 * `"device-ed25519"`. Mirrors the API of `device-x25519.ts`.
 */

import { randomBytes } from "node:crypto";
import { ed25519GetPublicKey, ed25519Sign, ed25519Verify } from "@brainstorm-os/native";
import {
	assertSecret as assertSecretLen,
	publicKeyFromBase64 as publicKeyFromBase64Len,
	publicKeyToBase64 as publicKeyToBase64Len,
} from "./key-codec";

export const ED25519_DEVICE_SECRET_BYTES = 32;
export const ED25519_DEVICE_PUBLIC_BYTES = 32;
export const ED25519_DEVICE_SIGNATURE_BYTES = 64;

export type DeviceEd25519Keypair = {
	secretKey: Uint8Array;
	publicKey: Uint8Array;
};

export function generateDeviceEd25519(): DeviceEd25519Keypair {
	const secretKey = new Uint8Array(randomBytes(ED25519_DEVICE_SECRET_BYTES));
	const publicKey = new Uint8Array(ed25519GetPublicKey(secretKey));
	return { secretKey, publicKey };
}

export function publicKeyFromSecret(secretKey: Uint8Array): Uint8Array {
	assertSecret(secretKey);
	return new Uint8Array(ed25519GetPublicKey(secretKey));
}

export function signWithDeviceKey(secretKey: Uint8Array, payload: Uint8Array): Uint8Array {
	assertSecret(secretKey);
	return new Uint8Array(ed25519Sign(secretKey, payload));
}

export function verifyDeviceSignature(
	publicKey: Uint8Array,
	payload: Uint8Array,
	signature: Uint8Array,
): boolean {
	if (publicKey.length !== ED25519_DEVICE_PUBLIC_BYTES) return false;
	if (signature.length !== ED25519_DEVICE_SIGNATURE_BYTES) return false;
	return ed25519Verify(publicKey, payload, signature);
}

export function publicKeyToBase64(publicKey: Uint8Array): string {
	return publicKeyToBase64Len(publicKey, ED25519_DEVICE_PUBLIC_BYTES);
}

export function publicKeyFromBase64(encoded: string): Uint8Array {
	return publicKeyFromBase64Len(encoded, ED25519_DEVICE_PUBLIC_BYTES);
}

function assertSecret(secretKey: Uint8Array): void {
	assertSecretLen(secretKey, ED25519_DEVICE_SECRET_BYTES);
}
