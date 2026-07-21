/**
 * Device X25519 keypair (Stage 10.2) — the recipient half of HPKE member
 * wraps per §3.2/§3.3.
 *
 * Distinct from the sovereign Ed25519 identity:
 *   - Ed25519 (`identity.ts`) signs add-device records + envelope headers.
 *   - X25519 (this module) is the recipient pubkey HPKE encapsulates a DEK
 *     against for any wrap addressed to this device.
 *
 * v1 ships one device per vault — `generateDeviceX25519()` is called once
 * by the vault session and the secret is persisted under the keystore
 * (sealed under the same backend that holds `identity` + `master`).
 * Stage 10.5 (pairing UX) will mint one keypair per paired device.
 *
 * Independent keypair, NOT derived from the Ed25519 secret: keeping them
 * orthogonal preserves the principle of separation of concerns (signing
 * vs. encryption) and avoids the well-known pitfalls of reusing curve
 * material across primitives.
 */

import { randomBytes } from "node:crypto";
import { x25519GetPublicKey } from "@brainstorm-os/native";
import {
	assertSecret as assertSecretLen,
	publicKeyFromBase64 as publicKeyFromBase64Len,
	publicKeyToBase64 as publicKeyToBase64Len,
} from "./key-codec";

export const X25519_SECRET_BYTES = 32;
export const X25519_PUBLIC_BYTES = 32;

export type DeviceX25519Keypair = {
	secretKey: Uint8Array; // 32 bytes
	publicKey: Uint8Array; // 32 bytes
};

export function generateDeviceX25519(): DeviceX25519Keypair {
	const secretKey = new Uint8Array(randomBytes(X25519_SECRET_BYTES));
	const publicKey = new Uint8Array(x25519GetPublicKey(secretKey));
	return { secretKey, publicKey };
}

export function publicKeyFromSecret(secretKey: Uint8Array): Uint8Array {
	assertSecret(secretKey);
	return new Uint8Array(x25519GetPublicKey(secretKey));
}

export function publicKeyToBase64(publicKey: Uint8Array): string {
	return publicKeyToBase64Len(publicKey, X25519_PUBLIC_BYTES);
}

export function publicKeyFromBase64(encoded: string): Uint8Array {
	return publicKeyFromBase64Len(encoded, X25519_PUBLIC_BYTES);
}

function assertSecret(secretKey: Uint8Array): void {
	assertSecretLen(secretKey, X25519_SECRET_BYTES);
}
