/**
 * Stage 10.5c — pairing wire frame.
 *
 * Pairing messages ride over the same blind relay as sync envelopes
 * (`WireKind.Pairing` in the routing header; `entityId` carries the
 * `pairingChannelId(pairingSecret)`). The frame layout matches
 * `envelope-codec.ts` exactly so the relay routes a pairing frame
 * identically to any other — no extra branches in the routing path.
 *
 *   u32-be(headerLen) || canonicalHeaderBytes
 *     || u16-be(sigLen=64) || sig
 *     || u32-be(bodyLen) || body
 *
 * Unlike sync envelopes, pairing bodies are **NOT** AEAD-encrypted under
 * a per-entity DEK. The body is one of two JSON-encoded shapes:
 *
 *   `JoinRequest`     — target → source, plaintext device-public-key
 *                       envelope. Carries the target's deviceEd25519Pub
 *                       + deviceX25519Pub + (optional) deviceLabel.
 *
 *   `SealedIdentity`  — source → target, AEAD-sealed identity secret
 *                       (already sealed under `pairingSecret` via
 *                       `exportSecretSealed`). The pairingSecret is
 *                       shared out-of-band via the QR payload, so the
 *                       wire frame body itself is the sealed shape.
 *
 * Signatures: the source signs every outbound pairing frame with its
 * **device-Ed25519** secret; the target's renderer-bound state machine
 * verifies sig using the `sourceEd25519Pub` it learned from the QR
 * payload. The target's `JoinRequest` is signed with its own
 * device-Ed25519 secret; the source verifies using the `deviceEd25519Pub`
 * carried in the join request itself (TOFU on the pairing channel — the
 * pairingSecret one-shot guard prevents replay; the user's SAS
 * confirmation gates the eventual identity install).
 *
 * The recipient is the last line of defence: a malformed body, a wrong
 * sender pubkey, or any inconsistency throws `Invalid`.
 */

import { Buffer } from "node:buffer";
import { ed25519Sign, ed25519Verify } from "@brainstorm-os/native";
import {
	type RoutingHeader,
	WireKind,
	canonicalizeRoutingHeader,
	parseRoutingHeaderJson,
} from "../sync/routing-header";

export const ED25519_SIG_BYTES = 64;

export enum PairingFrameType {
	JoinRequest = "join-request",
	SealedIdentity = "sealed-identity",
}

/** Target → source. Carries the target's device public keys. */
export type JoinRequestBody = {
	type: PairingFrameType.JoinRequest;
	deviceEd25519Pub: string;
	deviceX25519Pub: string;
	deviceLabel: string;
};

/** Source → target. Carries the AEAD-sealed identity secret + a copy of
 *  the source's device-Ed25519 pubkey (the target learned it via the QR
 *  payload too — we re-emit so a UI surface that wants to display "you're
 *  joining the device with fingerprint X" doesn't have to thread the QR
 *  state through the wire path). */
export type SealedIdentityBody = {
	type: PairingFrameType.SealedIdentity;
	/** Base64-encoded SealedSecret JSON. Carries `{nonce, ciphertext}` after
	 *  AEAD-sealing the 32-byte user-identity secret under `pairingSecret`. */
	sealed: string;
	sourceDeviceEd25519Pub: string;
};

export type PairingFrameBody = JoinRequestBody | SealedIdentityBody;

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export type EncodePairingFrameOptions = {
	channelId: string;
	body: PairingFrameBody;
	deviceEd25519Pub: Uint8Array;
	deviceEd25519Secret: Uint8Array;
	seq: number;
	nowMs: number;
	nonce: string;
};

export function encodePairingFrame(opts: EncodePairingFrameOptions): Uint8Array {
	if (!(opts.deviceEd25519Pub instanceof Uint8Array) || opts.deviceEd25519Pub.length !== 32) {
		throw invalid("encodePairingFrame: deviceEd25519Pub must be 32 bytes");
	}
	if (!(opts.deviceEd25519Secret instanceof Uint8Array) || opts.deviceEd25519Secret.length !== 32) {
		throw invalid("encodePairingFrame: deviceEd25519Secret must be 32 bytes");
	}
	if (!opts.channelId) throw invalid("encodePairingFrame: channelId is required");
	const header: RoutingHeader = {
		v: 1,
		kind: WireKind.Pairing,
		entityId: opts.channelId,
		sender: bytesToBase64Url(opts.deviceEd25519Pub),
		seq: opts.seq,
		nonce: opts.nonce,
		ts: opts.nowMs,
	};
	const headerBytes = canonicalizeRoutingHeader(header);
	const bodyBytes = TEXT_ENCODER.encode(JSON.stringify(opts.body));
	const toSign = new Uint8Array(headerBytes.length + bodyBytes.length);
	toSign.set(headerBytes, 0);
	toSign.set(bodyBytes, headerBytes.length);
	const sig = ed25519Sign(opts.deviceEd25519Secret, toSign);
	const total = 4 + headerBytes.length + 2 + sig.length + 4 + bodyBytes.length;
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	let off = 0;
	view.setUint32(off, headerBytes.length, false);
	off += 4;
	out.set(headerBytes, off);
	off += headerBytes.length;
	view.setUint16(off, sig.length, false);
	off += 2;
	out.set(sig, off);
	off += sig.length;
	view.setUint32(off, bodyBytes.length, false);
	off += 4;
	out.set(bodyBytes, off);
	return out;
}

export type DecodedPairingFrame = {
	header: RoutingHeader;
	body: PairingFrameBody;
	sig: Uint8Array;
};

/**
 * Decode + structurally validate a pairing frame. Does NOT verify the sig
 * — the caller chooses which pubkey to verify against (the QR-known
 * `sourceDeviceEd25519Pub` for the source→target direction; the
 * `deviceEd25519Pub` self-carried in the join-request body for the
 * target→source direction; TOFU on the channel gated by the SAS confirm).
 */
export function decodePairingFrame(bytes: Uint8Array): DecodedPairingFrame {
	if (bytes.length < 4) throw invalid("decodePairingFrame: truncated header length");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let off = 0;
	const headerLen = view.getUint32(off, false);
	off += 4;
	if (off + headerLen > bytes.length) throw invalid("decodePairingFrame: truncated header bytes");
	const headerBytes = bytes.subarray(off, off + headerLen);
	off += headerLen;
	if (off + 2 > bytes.length) throw invalid("decodePairingFrame: truncated sig length");
	const sigLen = view.getUint16(off, false);
	off += 2;
	if (sigLen !== ED25519_SIG_BYTES) {
		throw invalid(`decodePairingFrame: sig must be ${ED25519_SIG_BYTES} bytes`);
	}
	if (off + sigLen > bytes.length) throw invalid("decodePairingFrame: truncated sig bytes");
	const sig = bytes.subarray(off, off + sigLen);
	off += sigLen;
	if (off + 4 > bytes.length) throw invalid("decodePairingFrame: truncated body length");
	const bodyLen = view.getUint32(off, false);
	off += 4;
	if (off + bodyLen > bytes.length) throw invalid("decodePairingFrame: truncated body bytes");
	const bodyBytes = bytes.subarray(off, off + bodyLen);
	if (off + bodyLen !== bytes.length) throw invalid("decodePairingFrame: trailing bytes after body");
	const header = parseRoutingHeaderJson(headerBytes);
	if (header.kind !== WireKind.Pairing) {
		throw invalid(`decodePairingFrame: header.kind must be ${WireKind.Pairing}, got ${header.kind}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(TEXT_DECODER.decode(bodyBytes));
	} catch (error) {
		throw invalid(`decodePairingFrame: malformed body JSON (${(error as Error).message})`);
	}
	const body = assertPairingBody(parsed);
	return { header, body, sig: new Uint8Array(sig) };
}

/**
 * Verify a decoded pairing frame's sig against the expected device-Ed25519
 * pubkey. Recomputes the canonical-header-bytes-plus-body bytes so a
 * tampered sender or body fails the check.
 */
export function verifyPairingFrame(
	decoded: DecodedPairingFrame,
	expectedSenderPub: Uint8Array,
): boolean {
	if (!(expectedSenderPub instanceof Uint8Array) || expectedSenderPub.length !== 32) {
		return false;
	}
	if (decoded.header.sender !== bytesToBase64Url(expectedSenderPub)) {
		return false;
	}
	const headerBytes = canonicalizeRoutingHeader(decoded.header);
	const bodyBytes = TEXT_ENCODER.encode(JSON.stringify(decoded.body));
	const toVerify = new Uint8Array(headerBytes.length + bodyBytes.length);
	toVerify.set(headerBytes, 0);
	toVerify.set(bodyBytes, headerBytes.length);
	return ed25519Verify(expectedSenderPub, toVerify, decoded.sig);
}

function assertPairingBody(value: unknown): PairingFrameBody {
	if (!value || typeof value !== "object") throw invalid("pairing body: not an object");
	const v = value as Record<string, unknown>;
	if (v.type === PairingFrameType.JoinRequest) {
		const { deviceEd25519Pub, deviceX25519Pub, deviceLabel } = v;
		if (typeof deviceEd25519Pub !== "string" || deviceEd25519Pub.length === 0) {
			throw invalid("pairing body: JoinRequest.deviceEd25519Pub must be a non-empty string");
		}
		if (typeof deviceX25519Pub !== "string" || deviceX25519Pub.length === 0) {
			throw invalid("pairing body: JoinRequest.deviceX25519Pub must be a non-empty string");
		}
		if (typeof deviceLabel !== "string") {
			throw invalid("pairing body: JoinRequest.deviceLabel must be a string");
		}
		return {
			type: PairingFrameType.JoinRequest,
			deviceEd25519Pub,
			deviceX25519Pub,
			deviceLabel,
		};
	}
	if (v.type === PairingFrameType.SealedIdentity) {
		const { sealed, sourceDeviceEd25519Pub } = v;
		if (typeof sealed !== "string" || sealed.length === 0) {
			throw invalid("pairing body: SealedIdentity.sealed must be a non-empty string");
		}
		if (typeof sourceDeviceEd25519Pub !== "string" || sourceDeviceEd25519Pub.length === 0) {
			throw invalid("pairing body: SealedIdentity.sourceDeviceEd25519Pub must be a non-empty string");
		}
		return { type: PairingFrameType.SealedIdentity, sealed, sourceDeviceEd25519Pub };
	}
	throw invalid(`pairing body: unknown type=${String((v as { type?: unknown }).type)}`);
}

function bytesToBase64Url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

function invalid(message: string): Error {
	const err = new Error(message);
	err.name = "Invalid";
	return err;
}
