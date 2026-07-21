/**
 * Stage 10.3a — encrypt/decrypt one Yjs update envelope.
 *
 * Cipher: XChaCha20-Poly1305 (per OQ-25), keyed by the per-entity DEK
 * (Stage 10.1). Nonce is the 24-byte buffer that the routing header
 * surfaces as base64 (OQ-191 resolved 2026-05-23 → random per envelope,
 * no counter). AAD = `canonicalizeRoutingHeader(header)` — re-canonicalised
 * from the *decoded* header on every open so a caller-supplied object
 * cannot drift from what the relay routes on.
 *
 * Defense-in-depth on `openUpdateEnvelope`: **before** ever calling AEAD,
 *   (1) `frame.header.entityId === resolvedEntityId` — the 10.1/10.2
 *       forward-pin (recipient asserts the routed id matches the row
 *       they resolved against, never opens an envelope authored under a
 *       different entity id).
 *   (2) Ed25519 verify the signature over `canonicalHeaderBytes ||
 *       ciphertext`. A relay-forged envelope fails here without ever
 *       touching the AEAD path — and a tampered header is rejected
 *       before the DEK is even looked at.
 *
 * Both checks throw a *named* error (`EntityIdMismatch`, `Invalid`)
 * BEFORE any AEAD work, so a test can spy on the AEAD path and confirm
 * it was never reached on signature/id-mismatch failures.
 */

import { xchacha20Poly1305Open, xchacha20Poly1305Seal } from "@brainstorm-os/native";
import { XCHACHA_KEY_BYTES, XCHACHA_NONCE_BYTES, base64ToBytes } from "../credentials/crypto";
import { type MemberWrapPayload, isMemberWrapPayload } from "../credentials/member-wraps";
import type { EncryptedFrame } from "./envelope-codec";
import { type RoutingHeader, WireKind, canonicalizeRoutingHeader } from "./routing-header";

export type SealUpdateOptions = {
	dek: Uint8Array;
	header: RoutingHeader;
	payload: Uint8Array;
	sign: (bytes: Uint8Array) => Uint8Array;
};

export type OpenUpdateOptions = {
	frame: EncryptedFrame;
	dek: Uint8Array;
	resolvedEntityId: string;
	verify: (sig: Uint8Array, bytes: Uint8Array) => boolean;
	/** Stage 10.11 — routing-token mode. When the wire routes by a pseudonymous
	 *  token instead of the raw entity id, the header's `entityId` slot carries
	 *  the token; pass the token the RESOLVED entity is expected to route under
	 *  (re-derived from its DEK) and the check binds header ↔ row through the
	 *  derivation instead of raw string equality. Absent ⇒ legacy raw-id check. */
	expectedRoutingId?: string;
};

/**
 * Seal a Yjs update under `dek` with `header` as the AEAD AAD, then sign
 * the (canonical header || ciphertext) bytes with `sign` (the device's
 * Ed25519 secret never leaves the main process — `sign` is a closure).
 * The signature length is verified before returning so an upstream
 * `sign` that returned the wrong size fails fast, not on the recipient.
 */
export function sealUpdateEnvelope(opts: SealUpdateOptions): EncryptedFrame {
	assertDek(opts.dek);
	const headerBytes = canonicalizeRoutingHeader(opts.header);
	const nonce = base64ToBytes(opts.header.nonce);
	if (nonce.length !== XCHACHA_NONCE_BYTES) {
		throw invalid(`sealUpdateEnvelope: header.nonce must decode to ${XCHACHA_NONCE_BYTES} bytes`);
	}
	const ciphertext = xchacha20Poly1305Seal(opts.dek, nonce, opts.payload, headerBytes);
	const signed = concat(headerBytes, ciphertext);
	const sig = opts.sign(signed);
	if (!(sig instanceof Uint8Array) || sig.length !== 64) {
		throw invalid("sealUpdateEnvelope: sign() must return a 64-byte Uint8Array");
	}
	return {
		header: opts.header,
		ciphertext: new Uint8Array(ciphertext),
		sig: new Uint8Array(sig),
	};
}

/**
 * Open an envelope. Order of checks is load-bearing:
 *   1. routed entityId matches resolved row's id (no AEAD call).
 *   2. Ed25519 signature verifies (no AEAD call).
 *   3. AEAD opens with AAD = re-canonicalised header bytes.
 *
 * `EntityIdMismatch` is a named error class so the wire-path orchestrator
 * can distinguish "wrong row" from "tampered crypto"; both still fail
 * closed, just with a clearer audit trail.
 */
export function openUpdateEnvelope(opts: OpenUpdateOptions): Uint8Array {
	assertDek(opts.dek);
	if (opts.frame.header.entityId !== (opts.expectedRoutingId ?? opts.resolvedEntityId)) {
		throw new EntityIdMismatch(opts.frame.header.entityId, opts.resolvedEntityId);
	}
	const headerBytes = canonicalizeRoutingHeader(opts.frame.header);
	const signed = concat(headerBytes, opts.frame.ciphertext);
	if (!opts.verify(opts.frame.sig, signed)) {
		throw invalid("openUpdateEnvelope: signature verification failed");
	}
	const nonce = base64ToBytes(opts.frame.header.nonce);
	if (nonce.length !== XCHACHA_NONCE_BYTES) {
		throw invalid(`openUpdateEnvelope: header.nonce must decode to ${XCHACHA_NONCE_BYTES} bytes`);
	}
	return new Uint8Array(xchacha20Poly1305Open(opts.dek, nonce, opts.frame.ciphertext, headerBytes));
}

/**
 * Stage 10.3b — seal a `WrapBootstrap` envelope.
 *
 * Inner payload is `JSON.stringify(wrap)` bytes. The wrap itself is already
 * HPKE-sealed under the recipient device's X25519 pubkey (Stage 10.2), so
 * a second AEAD layer keyed by the DEK would be redundant — the DEK is
 * exactly what the wrap is delivering, so it cannot also wrap itself.
 *
 * The routing-header Ed25519 sig over `canonicalHeaderBytes || payloadBytes`
 * is the integrity surface: it binds the wrap to the sender pubkey, the
 * routed entity id, the seq/nonce/ts, and the wire kind. A relay that
 * substitutes the wrap bytes (or any header field) breaks the sig.
 *
 * `header.kind` MUST be `WireKind.WrapBootstrap`; the seal refuses other
 * kinds so a caller cannot route an `Update` payload through this seal
 * path and skip the AEAD layer.
 */
export type SealWrapBootstrapOptions = {
	header: RoutingHeader;
	wrap: MemberWrapPayload;
	sign: (bytes: Uint8Array) => Uint8Array;
};

export function sealWrapBootstrapEnvelope(opts: SealWrapBootstrapOptions): EncryptedFrame {
	if (opts.header.kind !== WireKind.WrapBootstrap) {
		throw invalid(`sealWrapBootstrapEnvelope: header.kind must be ${WireKind.WrapBootstrap}`);
	}
	if (!isMemberWrapPayload(opts.wrap)) {
		throw invalid("sealWrapBootstrapEnvelope: wrap is not a valid MemberWrapPayload");
	}
	const headerBytes = canonicalizeRoutingHeader(opts.header);
	const payload = new TextEncoder().encode(JSON.stringify(opts.wrap));
	const signed = concat(headerBytes, payload);
	const sig = opts.sign(signed);
	if (!(sig instanceof Uint8Array) || sig.length !== 64) {
		throw invalid("sealWrapBootstrapEnvelope: sign() must return a 64-byte Uint8Array");
	}
	return {
		header: opts.header,
		ciphertext: payload,
		sig: new Uint8Array(sig),
	};
}

/**
 * Stage 10.3b — open a `WrapBootstrap` envelope. Order of checks mirrors
 * `openUpdateEnvelope`:
 *
 *   1. `frame.header.kind === WrapBootstrap` (refuse a sender that signed
 *      an `Update` header but routes it through this path).
 *   2. `frame.header.entityId === resolvedEntityId` — the 10.1/10.2/10.3a
 *      forward contract (no AEAD work before the row match).
 *   3. Ed25519 verify the signature over `canonicalHeaderBytes || payload`.
 *   4. Parse the payload JSON and validate the shape via
 *      `isMemberWrapPayload`.
 *
 * Returns the parsed `MemberWrapPayload`. The actual HPKE unseal of the
 * inner DEK happens at the call site (typically `VaultSession.unwrapMemberWrap`)
 * because the X25519 secret never leaves the main process.
 */
export type OpenWrapBootstrapOptions = {
	frame: EncryptedFrame;
	resolvedEntityId: string;
	verify: (sig: Uint8Array, bytes: Uint8Array) => boolean;
	/** Stage 10.11 — routing-token mode (see `OpenUpdateOptions`). */
	expectedRoutingId?: string;
};

export function openWrapBootstrapEnvelope(opts: OpenWrapBootstrapOptions): MemberWrapPayload {
	if (opts.frame.header.kind !== WireKind.WrapBootstrap) {
		throw invalid(
			`openWrapBootstrapEnvelope: header.kind must be ${WireKind.WrapBootstrap}, got ${opts.frame.header.kind}`,
		);
	}
	if (opts.frame.header.entityId !== (opts.expectedRoutingId ?? opts.resolvedEntityId)) {
		throw new EntityIdMismatch(opts.frame.header.entityId, opts.resolvedEntityId);
	}
	const headerBytes = canonicalizeRoutingHeader(opts.frame.header);
	const signed = concat(headerBytes, opts.frame.ciphertext);
	if (!opts.verify(opts.frame.sig, signed)) {
		throw invalid("openWrapBootstrapEnvelope: signature verification failed");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(opts.frame.ciphertext));
	} catch (error) {
		throw invalid(`openWrapBootstrapEnvelope: malformed wrap JSON (${(error as Error).message})`);
	}
	if (!isMemberWrapPayload(parsed)) {
		throw invalid("openWrapBootstrapEnvelope: payload is not a valid MemberWrapPayload");
	}
	return parsed;
}

/**
 * Stage 10.6 — seal an `Awareness` envelope.
 *
 * Same AEAD path as `sealUpdateEnvelope`: XChaCha20-Poly1305 under the
 * per-entity DEK with AAD = `canonicalizeRoutingHeader(header)`. The only
 * differences are
 *   - `header.kind` MUST be `WireKind.Awareness` — refused otherwise so a
 *     caller cannot route a Yjs `Update` payload through this code path
 *     and lose the seq-tracker contract.
 *   - The plaintext payload is `awarenessProtocol.encodeAwarenessUpdate(...)`
 *     bytes; the seal does not interpret them.
 *
 * The empty payload is *allowed* — an awareness broadcaster emits an empty
 * update when it has nothing new to say (heartbeat) and on dispose it
 * emits the `state=null` update which is also short. The AEAD has no
 * minimum plaintext length.
 */
export type SealAwarenessOptions = {
	dek: Uint8Array;
	header: RoutingHeader;
	payload: Uint8Array;
	sign: (bytes: Uint8Array) => Uint8Array;
};

export function sealAwarenessEnvelope(opts: SealAwarenessOptions): EncryptedFrame {
	if (opts.header.kind !== WireKind.Awareness) {
		throw invalid(`sealAwarenessEnvelope: header.kind must be ${WireKind.Awareness}`);
	}
	assertDek(opts.dek);
	const headerBytes = canonicalizeRoutingHeader(opts.header);
	const nonce = base64ToBytes(opts.header.nonce);
	if (nonce.length !== XCHACHA_NONCE_BYTES) {
		throw invalid(`sealAwarenessEnvelope: header.nonce must decode to ${XCHACHA_NONCE_BYTES} bytes`);
	}
	const ciphertext = xchacha20Poly1305Seal(opts.dek, nonce, opts.payload, headerBytes);
	const signed = concat(headerBytes, ciphertext);
	const sig = opts.sign(signed);
	if (!(sig instanceof Uint8Array) || sig.length !== 64) {
		throw invalid("sealAwarenessEnvelope: sign() must return a 64-byte Uint8Array");
	}
	return {
		header: opts.header,
		ciphertext: new Uint8Array(ciphertext),
		sig: new Uint8Array(sig),
	};
}

/**
 * Stage 10.6 — open an `Awareness` envelope. Order of checks mirrors
 * `openUpdateEnvelope` AND adds the same explicit kind guard as the
 * `WrapBootstrap` path:
 *
 *   1. `frame.header.kind === Awareness` (refuse cross-kind routing).
 *   2. `frame.header.entityId === resolvedEntityId` (DEK-swap-vector close
 *      from the 10.1/10.2/10.3a forward contract).
 *   3. Ed25519 verify the signature over `canonicalHeaderBytes || ciphertext`.
 *   4. AEAD open with AAD = re-canonicalised header bytes.
 *
 * Returns the plaintext `awarenessUpdate` bytes — the caller is the
 * broadcaster, which feeds it into `applyAwarenessUpdate(awareness, ...)`.
 * Whether those bytes are a well-formed y-protocols awareness update is
 * NOT this layer's concern (a parse error surfaces from
 * `applyAwarenessUpdate` itself).
 */
export type OpenAwarenessOptions = {
	frame: EncryptedFrame;
	dek: Uint8Array;
	resolvedEntityId: string;
	verify: (sig: Uint8Array, bytes: Uint8Array) => boolean;
	/** Stage 10.11 — routing-token mode (see `OpenUpdateOptions`). */
	expectedRoutingId?: string;
};

export function openAwarenessEnvelope(opts: OpenAwarenessOptions): Uint8Array {
	if (opts.frame.header.kind !== WireKind.Awareness) {
		throw invalid(
			`openAwarenessEnvelope: header.kind must be ${WireKind.Awareness}, got ${opts.frame.header.kind}`,
		);
	}
	assertDek(opts.dek);
	if (opts.frame.header.entityId !== (opts.expectedRoutingId ?? opts.resolvedEntityId)) {
		throw new EntityIdMismatch(opts.frame.header.entityId, opts.resolvedEntityId);
	}
	const headerBytes = canonicalizeRoutingHeader(opts.frame.header);
	const signed = concat(headerBytes, opts.frame.ciphertext);
	if (!opts.verify(opts.frame.sig, signed)) {
		throw invalid("openAwarenessEnvelope: signature verification failed");
	}
	const nonce = base64ToBytes(opts.frame.header.nonce);
	if (nonce.length !== XCHACHA_NONCE_BYTES) {
		throw invalid(`openAwarenessEnvelope: header.nonce must decode to ${XCHACHA_NONCE_BYTES} bytes`);
	}
	return new Uint8Array(xchacha20Poly1305Open(opts.dek, nonce, opts.frame.ciphertext, headerBytes));
}

export class EntityIdMismatch extends Error {
	readonly routed: string;
	readonly resolved: string;
	constructor(routed: string, resolved: string) {
		super(`envelope-seal: routed entityId ${routed} does not match resolved row ${resolved}`);
		this.name = "EntityIdMismatch";
		this.routed = routed;
		this.resolved = resolved;
	}
}

function assertDek(dek: Uint8Array): void {
	if (!(dek instanceof Uint8Array) || dek.length !== XCHACHA_KEY_BYTES) {
		throw invalid(`envelope-seal: dek must be a ${XCHACHA_KEY_BYTES}-byte Uint8Array`);
	}
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
}

function invalid(message: string): Error {
	const err = new Error(message);
	err.name = "Invalid";
	return err;
}
