/**
 * Pairing channel id (Stage 10.5a).
 *
 *   pairingChannelId = base64url(sha256("brainstorm/v1/pair" || pairingSecret))
 *
 * Both pairing devices derive the same id from the same `pairingSecret`; the
 * envelope pipeline routes pairing messages through the same relay path as
 * sync envelopes using the channel id where a regular sync envelope uses
 * `entityId`. The id is **not** an entity DEK path — no entity DEK is
 * involved in pairing.
 *
 * The SHA-256 + domain-separator prefix prevents a leaked `pairingSecret`
 * from doubling as a routing key for anything else; two distinct secrets
 * produce two distinct channel ids with overwhelming probability.
 *
 * Also exports the base64url helpers the codec + handshake share. Putting
 * them here (rather than `pairing-payload.ts`) keeps the dependency cycle
 * out and gives a stable single-source pair `bytesToBase64Url` /
 * `base64UrlToBytes` for the pairing subsystem.
 */

import { sha256 } from "@brainstorm-os/native";

export const PAIRING_CHANNEL_DOMAIN = "brainstorm/v1/pair";

const PAIRING_CHANNEL_PREFIX = new TextEncoder().encode(PAIRING_CHANNEL_DOMAIN);

export function pairingChannelId(pairingSecret: Uint8Array): string {
	if (!(pairingSecret instanceof Uint8Array) || pairingSecret.length !== 32) {
		throw new Error("pairingChannelId: pairingSecret must be 32 bytes");
	}
	const combined = new Uint8Array(PAIRING_CHANNEL_PREFIX.length + pairingSecret.length);
	combined.set(PAIRING_CHANNEL_PREFIX, 0);
	combined.set(pairingSecret, PAIRING_CHANNEL_PREFIX.length);
	return bytesToBase64Url(sha256(combined));
}

export function bytesToBase64Url(bytes: Uint8Array): string {
	const b64 = Buffer.from(bytes).toString("base64");
	return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(encoded: string): Uint8Array {
	const padded =
		encoded.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (encoded.length % 4)) % 4);
	return new Uint8Array(Buffer.from(padded, "base64"));
}
