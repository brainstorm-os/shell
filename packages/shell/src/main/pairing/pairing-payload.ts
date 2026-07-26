/**
 * Pairing-payload codec (Stage 10.5a). The QR/SAS-handover payload an
 * already-paired device (A) generates and a new device (B) decodes. Binary
 * layout — see iteration spec — base64url-encoded for QR / paste:
 *
 *   u8     version        = 0x01
 *   u8     mode           = 0x01 (qr) | 0x02 (sas)
 *   bytes  userEd25519Pub  [32]
 *   bytes  userEd25519Sec  [32]   QR: AEAD-sealed by pairing key (the renderer
 *                                 never sees plaintext). SAS: 32 zero bytes
 *                                 (derived later via ECDH+HKDF).
 *   bytes  pairingSecret   [32]   QR: random. SAS: 32 zero bytes.
 *   bytes  sourceEd25519Pub[32]   device A's deviceEd25519 pubkey
 *   u16-be relayUrlLen
 *   bytes  relayUrl        [N]    utf-8
 *   u32-be expiresAt              unix seconds; default = now + 120 (OQ-201)
 *
 * `version` MUST be `0x01`; future versions bump the byte and live behind a
 * new codec. `mode` MUST be one of the two enum values; anything else throws
 * `Invalid`. Strict length checks throw `Invalid` rather than silently
 * truncating — a malformed payload from a third-party QR scan must fail
 * fast, never half-decode.
 */

import { base64UrlToBytes, bytesToBase64Url } from "./pairing-channel";

export const PAIRING_PAYLOAD_VERSION = 0x01 as const;
export const PAIRING_PUBKEY_BYTES = 32;
export const PAIRING_SECRET_BYTES = 32;
export const PAIRING_DEFAULT_TTL_SECONDS = 120;
export const PAIRING_MAX_RELAY_URL_BYTES = 2048;

export enum PairingMode {
	Qr = "qr",
	Sas = "sas",
}

const MODE_BYTE_QR = 0x01;
const MODE_BYTE_SAS = 0x02;

function isPairingMode(value: string): value is PairingMode {
	return value === PairingMode.Qr || value === PairingMode.Sas;
}

function modeToByte(mode: PairingMode): number {
	switch (mode) {
		case PairingMode.Qr:
			return MODE_BYTE_QR;
		case PairingMode.Sas:
			return MODE_BYTE_SAS;
	}
}

function modeFromByte(byte: number): PairingMode {
	switch (byte) {
		case MODE_BYTE_QR:
			return PairingMode.Qr;
		case MODE_BYTE_SAS:
			return PairingMode.Sas;
		default:
			throwInvalid(`unsupported pairing mode byte 0x${byte.toString(16)}`);
	}
}

export type PairingPayload = {
	version: typeof PAIRING_PAYLOAD_VERSION;
	mode: PairingMode;
	userEd25519Pub: Uint8Array;
	/**
	 * QR: AEAD-ciphertext+tag of the 32-byte user secret sealed under the
	 * pairing key. SAS: 32 bytes of zero — the SAS flow does an ECDH after
	 * SAS confirmation to deliver the secret separately.
	 *
	 * The on-wire length is fixed at 32 in QR mode (the codec carries the
	 * AEAD output in a parallel out-of-payload channel for v1's simplicity
	 * — see `pairing-handshake.ts` for the actual sealed-bytes path). The
	 * field exists in both modes so the binary layout is the same.
	 */
	userEd25519Sec: Uint8Array;
	pairingSecret: Uint8Array;
	sourceEd25519Pub: Uint8Array;
	relayUrl: string;
	expiresAt: number;
};

export function encodePairingPayload(payload: PairingPayload): string {
	assertField("userEd25519Pub", payload.userEd25519Pub, PAIRING_PUBKEY_BYTES);
	assertField("userEd25519Sec", payload.userEd25519Sec, PAIRING_PUBKEY_BYTES);
	assertField("pairingSecret", payload.pairingSecret, PAIRING_SECRET_BYTES);
	assertField("sourceEd25519Pub", payload.sourceEd25519Pub, PAIRING_PUBKEY_BYTES);
	if (!isPairingMode(payload.mode)) {
		throwInvalid(`unknown pairing mode: ${String(payload.mode)}`);
	}
	if (payload.version !== PAIRING_PAYLOAD_VERSION) {
		throwInvalid(`unsupported pairing-payload version: ${String(payload.version)}`);
	}
	if (typeof payload.relayUrl !== "string" || payload.relayUrl.length === 0) {
		throwInvalid("relayUrl must be a non-empty string");
	}
	// SECURITY (LAN-3 / gate pentest #6) — the pairing payload comes from a QR
	// the user scanned, and this URL is dialed unattended afterwards. Without a
	// scheme allow-list a malicious payload could point the target at an
	// arbitrary scheme or host. Content stays E2EE either way, but the dial
	// itself (and the subscribe traffic that follows) should never be steerable
	// to a non-relay endpoint.
	if (!isDialableRelayUrl(payload.relayUrl)) {
		throwInvalid("relayUrl must be a ws:// or wss:// URL");
	}
	const relayBytes = new TextEncoder().encode(payload.relayUrl);
	if (relayBytes.length > PAIRING_MAX_RELAY_URL_BYTES) {
		throwInvalid(
			`relayUrl exceeds max length (${relayBytes.length} > ${PAIRING_MAX_RELAY_URL_BYTES})`,
		);
	}
	if (relayBytes.length > 0xffff) {
		throwInvalid("relayUrl exceeds u16 length field");
	}
	if (
		!Number.isInteger(payload.expiresAt) ||
		payload.expiresAt < 0 ||
		payload.expiresAt > 0xffffffff
	) {
		throwInvalid(`expiresAt must be a u32 unix-seconds integer, got ${payload.expiresAt}`);
	}

	const totalLength =
		1 + // version
		1 + // mode
		PAIRING_PUBKEY_BYTES + // userEd25519Pub
		PAIRING_PUBKEY_BYTES + // userEd25519Sec
		PAIRING_SECRET_BYTES + // pairingSecret
		PAIRING_PUBKEY_BYTES + // sourceEd25519Pub
		2 + // relayUrlLen
		relayBytes.length +
		4; // expiresAt

	const out = new Uint8Array(totalLength);
	let off = 0;
	out[off++] = PAIRING_PAYLOAD_VERSION;
	out[off++] = modeToByte(payload.mode);
	out.set(payload.userEd25519Pub, off);
	off += PAIRING_PUBKEY_BYTES;
	out.set(payload.userEd25519Sec, off);
	off += PAIRING_PUBKEY_BYTES;
	out.set(payload.pairingSecret, off);
	off += PAIRING_SECRET_BYTES;
	out.set(payload.sourceEd25519Pub, off);
	off += PAIRING_PUBKEY_BYTES;
	const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
	view.setUint16(off, relayBytes.length, false);
	off += 2;
	out.set(relayBytes, off);
	off += relayBytes.length;
	view.setUint32(off, payload.expiresAt, false);

	return bytesToBase64Url(out);
}

export function decodePairingPayload(encoded: string): PairingPayload {
	if (typeof encoded !== "string" || encoded.length === 0) {
		throwInvalid("pairing payload must be a non-empty base64url string");
	}
	let bytes: Uint8Array;
	try {
		bytes = base64UrlToBytes(encoded);
	} catch {
		throwInvalid("pairing payload base64url decode failed");
	}

	const headerSize =
		1 +
		1 +
		PAIRING_PUBKEY_BYTES +
		PAIRING_PUBKEY_BYTES +
		PAIRING_SECRET_BYTES +
		PAIRING_PUBKEY_BYTES +
		2;
	if (bytes.length < headerSize + 4) {
		throwInvalid(`pairing payload truncated (got ${bytes.length} bytes)`);
	}

	let off = 0;
	const version = bytes[off++] as number;
	if (version !== PAIRING_PAYLOAD_VERSION) {
		throwInvalid(`unsupported pairing-payload version byte 0x${version.toString(16)}`);
	}
	const modeByte = bytes[off++] as number;
	const mode = modeFromByte(modeByte);
	const userEd25519Pub = bytes.slice(off, off + PAIRING_PUBKEY_BYTES);
	off += PAIRING_PUBKEY_BYTES;
	const userEd25519Sec = bytes.slice(off, off + PAIRING_PUBKEY_BYTES);
	off += PAIRING_PUBKEY_BYTES;
	const pairingSecret = bytes.slice(off, off + PAIRING_SECRET_BYTES);
	off += PAIRING_SECRET_BYTES;
	const sourceEd25519Pub = bytes.slice(off, off + PAIRING_PUBKEY_BYTES);
	off += PAIRING_PUBKEY_BYTES;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const relayUrlLen = view.getUint16(off, false);
	off += 2;

	if (relayUrlLen === 0) {
		throwInvalid("relayUrl length must be > 0");
	}
	if (relayUrlLen > PAIRING_MAX_RELAY_URL_BYTES) {
		throwInvalid(`relayUrl length ${relayUrlLen} exceeds max ${PAIRING_MAX_RELAY_URL_BYTES}`);
	}
	if (bytes.length < off + relayUrlLen + 4) {
		throwInvalid("pairing payload relay-url section truncated");
	}
	const relayBytes = bytes.slice(off, off + relayUrlLen);
	off += relayUrlLen;
	const expiresAt = view.getUint32(off, false);
	off += 4;

	if (off !== bytes.length) {
		throwInvalid(`pairing payload has ${bytes.length - off} trailing bytes`);
	}

	let relayUrl: string;
	try {
		relayUrl = new TextDecoder("utf-8", { fatal: true }).decode(relayBytes);
	} catch {
		throwInvalid("relayUrl is not valid UTF-8");
	}
	if (relayUrl.length === 0) {
		throwInvalid("relayUrl decoded to empty string");
	}

	return {
		version: PAIRING_PAYLOAD_VERSION,
		mode,
		userEd25519Pub,
		userEd25519Sec,
		pairingSecret,
		sourceEd25519Pub,
		relayUrl,
		expiresAt,
	};
}

/** Convenience predicate the IPC service uses to short-circuit a stale scan
 *  before the heavier validation. `nowSeconds` lets tests inject a deterministic
 *  clock. */
export function isPairingPayloadExpired(
	payload: Pick<PairingPayload, "expiresAt">,
	nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
	return payload.expiresAt <= nowSeconds;
}

function assertField(name: string, value: Uint8Array, length: number): void {
	if (!(value instanceof Uint8Array) || value.length !== length) {
		throwInvalid(`field ${name} must be ${length} bytes (got ${value?.length ?? "undefined"})`);
	}
}

function throwInvalid(message: string): never {
	const err = new Error(`pairing-payload: ${message}`);
	err.name = "Invalid";
	throw err;
}

/**
 * Is `url` something we are willing to dial as a relay? `ws:`/`wss:` only, with
 * a host. Deliberately strict: an allow-list, not a deny-list, so a scheme we
 * have not thought about is refused rather than tried.
 *
 * LAN bootstrap (LAN-3) puts `ws://<lan-ip>:<port>` here at pair time, which
 * this accepts; a plaintext `ws://` is only sound because admission is
 * channel-bound (see `lan-channel-binding.md`).
 */
export function isDialableRelayUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return false;
		return parsed.hostname.length > 0;
	} catch {
		return false;
	}
}
