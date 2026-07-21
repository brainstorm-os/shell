/**
 * Short Authentication String derivation (Stage 10.5a, OQ-200).
 *
 * Both pairing devices derive the same 6-digit code from a shared secret
 * (the X25519 ECDH shared key for the SAS-mode flow, or the QR-mode's
 * pairingSecret as a courtesy confirm-by-paste). The user reads the SAS on
 * both screens and confirms a match before any sensitive material crosses
 * the pairing channel.
 *
 * HKDF-SHA256 with a domain-separated `info` string, 4 output bytes
 * projected to a decimal number modulo 1,000,000, zero-padded to 6 digits.
 * 4 bytes is intentional: a 6-digit code carries log₂(10⁶) ≈ 19.93 bits of
 * entropy, well under 32; the user reads the projected number, not the raw
 * bytes, so 4 vs 5 bytes makes no difference to security. The fixed length
 * keeps the UI legible.
 */

import { hkdfSha256 } from "@brainstorm-os/native";

export const SAS_INFO_DEFAULT = "brainstorm/v1/pair/sas";
export const SAS_INFO_QR_CONFIRM = "brainstorm/v1/pair/qr-sas";
export const SAS_DIGITS = 6;
export const SAS_OUTPUT_BYTES = 4;
const SAS_MODULUS = 1_000_000;

export function deriveSas(shared: Uint8Array, info: string = SAS_INFO_DEFAULT): string {
	if (!(shared instanceof Uint8Array) || shared.length === 0) {
		throw new Error("deriveSas: shared must be a non-empty Uint8Array");
	}
	if (typeof info !== "string" || info.length === 0) {
		throw new Error("deriveSas: info must be a non-empty string");
	}
	const infoBytes = new TextEncoder().encode(info);
	const out = hkdfSha256(shared, null, infoBytes, SAS_OUTPUT_BYTES);
	const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
	const raw = view.getUint32(0, false);
	const projected = raw % SAS_MODULUS;
	return projected.toString().padStart(SAS_DIGITS, "0");
}
