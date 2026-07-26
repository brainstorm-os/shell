import { describe, expect, it } from "vitest";
import { base64UrlToBytes, bytesToBase64Url } from "./pairing-channel";
import {
	PAIRING_DEFAULT_TTL_SECONDS,
	PAIRING_MAX_RELAY_URL_BYTES,
	PAIRING_PAYLOAD_VERSION,
	PAIRING_PUBKEY_BYTES,
	PAIRING_SECRET_BYTES,
	PairingMode,
	type PairingPayload,
	decodePairingPayload,
	encodePairingPayload,
	isDialableRelayUrl,
	isPairingPayloadExpired,
} from "./pairing-payload";

function fillBytes(value: number, length: number): Uint8Array {
	return new Uint8Array(length).fill(value);
}

function basePayload(overrides: Partial<PairingPayload> = {}): PairingPayload {
	return {
		version: PAIRING_PAYLOAD_VERSION,
		mode: PairingMode.Qr,
		userEd25519Pub: fillBytes(0x01, PAIRING_PUBKEY_BYTES),
		userEd25519Sec: fillBytes(0x02, PAIRING_PUBKEY_BYTES),
		pairingSecret: fillBytes(0x03, PAIRING_SECRET_BYTES),
		sourceEd25519Pub: fillBytes(0x04, PAIRING_PUBKEY_BYTES),
		relayUrl: "wss://relay.example.test/v1",
		expiresAt: 1_700_000_000,
		...overrides,
	};
}

describe("pairing-payload codec", () => {
	it("encodes + decodes a QR payload round-trip", () => {
		const original = basePayload();
		const encoded = encodePairingPayload(original);
		expect(typeof encoded).toBe("string");
		expect(encoded.length).toBeGreaterThan(0);
		const decoded = decodePairingPayload(encoded);
		expect(decoded.version).toBe(PAIRING_PAYLOAD_VERSION);
		expect(decoded.mode).toBe(PairingMode.Qr);
		expect(decoded.relayUrl).toBe(original.relayUrl);
		expect(decoded.expiresAt).toBe(original.expiresAt);
		expect(Buffer.compare(decoded.userEd25519Pub, original.userEd25519Pub)).toBe(0);
		expect(Buffer.compare(decoded.pairingSecret, original.pairingSecret)).toBe(0);
		expect(Buffer.compare(decoded.sourceEd25519Pub, original.sourceEd25519Pub)).toBe(0);
	});

	it("encodes + decodes a SAS-mode payload round-trip", () => {
		const original = basePayload({ mode: PairingMode.Sas });
		const decoded = decodePairingPayload(encodePairingPayload(original));
		expect(decoded.mode).toBe(PairingMode.Sas);
	});

	it("rejects a wrong version byte", () => {
		const payload = basePayload();
		const encoded = encodePairingPayload(payload);
		const bytes = base64UrlToBytes(encoded);
		bytes[0] = 0x02;
		const tampered = bytesToBase64Url(bytes);
		expect(() => decodePairingPayload(tampered)).toThrowError(/version/);
	});

	it("rejects a wrong mode byte", () => {
		const payload = basePayload();
		const encoded = encodePairingPayload(payload);
		const bytes = base64UrlToBytes(encoded);
		bytes[1] = 0x09;
		const tampered = bytesToBase64Url(bytes);
		expect(() => decodePairingPayload(tampered)).toThrowError(/mode/);
	});

	it("rejects encode with an out-of-set mode", () => {
		expect(() => encodePairingPayload(basePayload({ mode: "unknown" as PairingMode }))).toThrowError(
			/mode/,
		);
	});

	it("rejects malformed base64url", () => {
		expect(() => decodePairingPayload("not!!!base64url***")).toThrowError(
			/base64url decode|truncated/,
		);
	});

	it("rejects encode with wrong-size byte fields", () => {
		expect(() =>
			encodePairingPayload(basePayload({ userEd25519Pub: fillBytes(0x01, 16) })),
		).toThrowError(/userEd25519Pub/);
		expect(() =>
			encodePairingPayload(basePayload({ pairingSecret: fillBytes(0x01, 64) })),
		).toThrowError(/pairingSecret/);
		expect(() =>
			encodePairingPayload(basePayload({ sourceEd25519Pub: fillBytes(0x01, 0) })),
		).toThrowError(/sourceEd25519Pub/);
	});

	it("rejects empty relayUrl on encode + decode", () => {
		expect(() => encodePairingPayload(basePayload({ relayUrl: "" }))).toThrowError(/relayUrl/);
		// Manually craft a payload with relayUrlLen = 0.
		const payload = basePayload();
		const encoded = encodePairingPayload(payload);
		const bytes = base64UrlToBytes(encoded);
		const lenOffset = 1 + 1 + 4 * PAIRING_PUBKEY_BYTES;
		bytes[lenOffset] = 0;
		bytes[lenOffset + 1] = 0;
		expect(() => decodePairingPayload(bytesToBase64Url(bytes))).toThrowError(/relayUrl length/);
	});

	it("rejects relayUrl larger than the per-payload cap", () => {
		const big = "x".repeat(PAIRING_MAX_RELAY_URL_BYTES + 1);
		expect(() => encodePairingPayload(basePayload({ relayUrl: big }))).toThrowError(/relayUrl/);
	});

	it("rejects invalid UTF-8 in relayUrl on decode", () => {
		const payload = basePayload();
		const encoded = encodePairingPayload(payload);
		const bytes = base64UrlToBytes(encoded);
		const relayStart = 1 + 1 + 4 * PAIRING_PUBKEY_BYTES + 2;
		const relayLen = payload.relayUrl.length;
		// Splice in an invalid 2-byte UTF-8 lead.
		bytes[relayStart] = 0xc3;
		bytes[relayStart + 1] = 0x28;
		const tampered = bytesToBase64Url(bytes);
		expect(() => decodePairingPayload(tampered)).toThrowError(/UTF-8/);
		expect(relayLen).toBeGreaterThan(2);
	});

	it("rejects a length-mismatch (trailing bytes after relayUrl section)", () => {
		const payload = basePayload();
		const encoded = encodePairingPayload(payload);
		const bytes = base64UrlToBytes(encoded);
		const extended = new Uint8Array(bytes.length + 2);
		extended.set(bytes, 0);
		extended[bytes.length] = 0xff;
		extended[bytes.length + 1] = 0xff;
		expect(() => decodePairingPayload(bytesToBase64Url(extended))).toThrowError(/trailing/);
	});

	it("rejects a truncated payload", () => {
		const payload = basePayload();
		const encoded = encodePairingPayload(payload);
		const bytes = base64UrlToBytes(encoded);
		const truncated = bytes.subarray(0, bytes.length - 5);
		expect(() => decodePairingPayload(bytesToBase64Url(truncated))).toThrowError(/truncated/);
	});

	it("rejects non-integer / out-of-range expiresAt on encode", () => {
		expect(() => encodePairingPayload(basePayload({ expiresAt: -1 }))).toThrowError(/expiresAt/);
		expect(() => encodePairingPayload(basePayload({ expiresAt: 2 ** 33 }))).toThrowError(/expiresAt/);
		expect(() => encodePairingPayload(basePayload({ expiresAt: 1.5 }))).toThrowError(/expiresAt/);
	});

	it("isPairingPayloadExpired reports expiry correctly", () => {
		const payload = basePayload({ expiresAt: 100 });
		expect(isPairingPayloadExpired(payload, 99)).toBe(false);
		expect(isPairingPayloadExpired(payload, 100)).toBe(true);
		expect(isPairingPayloadExpired(payload, 101)).toBe(true);
	});

	it("default TTL constant matches OQ-201 (120 seconds)", () => {
		expect(PAIRING_DEFAULT_TTL_SECONDS).toBe(120);
	});
});

describe("relayUrl scheme allow-list (LAN-3 / gate pentest #6)", () => {
	it("accepts ws:// and wss://, including a LAN bootstrap address", () => {
		expect(isDialableRelayUrl("wss://relay.example.com")).toBe(true);
		expect(isDialableRelayUrl("ws://192.168.1.20:8443")).toBe(true);
	});

	it("refuses every other scheme, and anything unparseable", () => {
		for (const url of [
			"http://evil.example.com",
			"https://evil.example.com",
			"file:///etc/passwd",
			"javascript:alert(1)",
			"ftp://host/x",
			"not a url",
			"ws://",
		]) {
			expect(isDialableRelayUrl(url)).toBe(false);
		}
	});
});
