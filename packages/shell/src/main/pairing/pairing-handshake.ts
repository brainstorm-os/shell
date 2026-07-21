/**
 * Pairing handshake state machines (Stage 10.5a).
 *
 * Two paths converge on the same outcome — device B holds the user-Ed25519
 * secret + signs an add-device record:
 *
 *   QR — A displays a payload that already contains the user secret AEAD-
 *        sealed under a fresh `pairingSecret`; B scans, decodes, opens the
 *        seal, installs the secret. The 6-digit code shown next to the QR
 *        is a courtesy confirm in case B's camera can't see it and the
 *        user pastes the payload manually instead.
 *
 *   SAS — A and B each generate an ephemeral X25519 keypair, exchange
 *         pubkeys over a pairing channel, derive a shared secret via
 *         X25519 ECDH, project to a `pairingSecret = HKDF(shared,
 *         "brainstorm/v1/pair/secret", 32)` AND a 6-digit SAS = HKDF(...,
 *         "brainstorm/v1/pair/sas", 4). Both screens show the SAS; user
 *         confirms a match on both ends; only then does A AEAD-seal the
 *         user-Ed25519 secret under `pairingSecret` and send to B.
 *
 * Both paths converge: B receives + decrypts the user-Ed25519 secret,
 * installs it into its keystore under "identity", signs an `add-device`
 * record, posts to `meta.devices`. The post-pairing wire path (sync) is
 * already in place since 10.3b — this module only owns the *pairing*
 * handshake, not the entity-doc bootstrap.
 *
 * State machines are headless: the IPC service (`pairing-service.ts`)
 * drives them; the UI (10.5b/c) reads `state` + dispatches transitions.
 * No DOM imports, no Electron imports.
 */

import { randomBytes } from "node:crypto";
import {
	ed25519GetPublicKey,
	hkdfSha256,
	x25519GetPublicKey,
	x25519GetSharedSecret,
} from "@brainstorm-os/native";
import type { SealedSecret } from "../credentials/crypto";
import {
	IDENTITY_SECRET_BYTES,
	type PairingChannelGuard,
	exportSecretSealed,
	importSecretSealed,
} from "../credentials/identity-export";
import { base64UrlToBytes, bytesToBase64Url, pairingChannelId } from "./pairing-channel";
import {
	PAIRING_DEFAULT_TTL_SECONDS,
	PAIRING_PAYLOAD_VERSION,
	PairingMode,
	type PairingPayload,
	decodePairingPayload,
	encodePairingPayload,
	isPairingPayloadExpired,
} from "./pairing-payload";
import { SAS_INFO_DEFAULT, SAS_INFO_QR_CONFIRM, deriveSas } from "./sas";

const SECRET_HKDF_INFO = new TextEncoder().encode("brainstorm/v1/pair/secret");

export enum PairingState {
	Idle = "idle",
	WaitingForJoin = "waiting-for-join",
	HandshakeInFlight = "handshake-in-flight",
	Paired = "paired",
	Cancelled = "cancelled",
	Expired = "expired",
	Error = "error",
}

export type HandshakeContext = {
	/** Current Unix-second clock; injectable for tests. */
	now: () => number;
	/** Random 32-byte source; injectable for tests. */
	randomBytes32: () => Uint8Array;
};

const DEFAULT_CONTEXT: HandshakeContext = {
	now: () => Math.floor(Date.now() / 1000),
	randomBytes32: () => new Uint8Array(randomBytes(32)),
};

export type SourceDeviceInputs = {
	userEd25519Pub: Uint8Array;
	userEd25519Sec: Uint8Array;
	sourceDeviceEd25519Pub: Uint8Array;
	relayUrl: string;
	ttlSeconds?: number;
};

export type QrStartResult = {
	payload: string;
	pairingSecret: Uint8Array;
	channelId: string;
	sas: string;
	expiresAt: number;
};

/**
 * Source-side: build the QR payload + the courtesy SAS in one step. The
 * caller (pairing-service) hands the payload to the renderer for QR
 * rendering AND keeps the pairingSecret in-process (it never crosses IPC
 * — the renderer holds the encoded payload only, not the secret bytes).
 */
export function startQrHandshakeOnSource(
	inputs: SourceDeviceInputs,
	context: Partial<HandshakeContext> = {},
): QrStartResult {
	assertPubkey("userEd25519Pub", inputs.userEd25519Pub);
	assertSecret("userEd25519Sec", inputs.userEd25519Sec);
	assertPubkey("sourceDeviceEd25519Pub", inputs.sourceDeviceEd25519Pub);
	if (typeof inputs.relayUrl !== "string" || inputs.relayUrl.length === 0) {
		throwInvalid("relayUrl must be a non-empty string");
	}
	const ctx = { ...DEFAULT_CONTEXT, ...context };
	const pairingSecret = ctx.randomBytes32();
	if (pairingSecret.length !== 32) {
		throwInvalid("randomBytes32 must produce 32 bytes");
	}
	const expiresAt = ctx.now() + (inputs.ttlSeconds ?? PAIRING_DEFAULT_TTL_SECONDS);
	const sas = deriveSas(pairingSecret, SAS_INFO_QR_CONFIRM);
	const channelId = pairingChannelId(pairingSecret);

	const payload: PairingPayload = {
		version: PAIRING_PAYLOAD_VERSION,
		mode: PairingMode.Qr,
		userEd25519Pub: inputs.userEd25519Pub,
		// The QR payload carries the user secret in a *separate* AEAD-sealed
		// channel — see `sealQrIdentityForB`. The on-payload `userEd25519Sec`
		// field is reserved for forward compatibility and zeroed at v1.
		userEd25519Sec: new Uint8Array(32),
		pairingSecret,
		sourceEd25519Pub: inputs.sourceDeviceEd25519Pub,
		relayUrl: inputs.relayUrl,
		expiresAt,
	};
	const encoded = encodePairingPayload(payload);
	return { payload: encoded, pairingSecret, channelId, sas, expiresAt };
}

/** Source-side: seal the user-Ed25519 secret under the pairingSecret. The
 *  caller posts the resulting `SealedSecret` over the pairing channel to B
 *  AFTER B has scanned the QR (or computed the SAS). */
export function sealQrIdentityForB(
	identitySecret: Uint8Array,
	pairingSecret: Uint8Array,
): SealedSecret {
	return exportSecretSealed(identitySecret, pairingSecret);
}

export type QrJoinInputs = {
	encodedPayload: string;
	sealedIdentity: SealedSecret;
	guard: PairingChannelGuard;
};

export type QrJoinResult = {
	identitySecret: Uint8Array;
	userEd25519Pub: Uint8Array;
	pairingSecret: Uint8Array;
	relayUrl: string;
	channelId: string;
	sas: string;
	sourceDeviceEd25519Pub: Uint8Array;
};

/**
 * Target-side (B) QR join: decodes the payload, validates expiry, opens the
 * AEAD-sealed identity using the pairingSecret bundled in the payload, and
 * returns the materialised inputs the service needs to install the identity
 * + sign an add-device record. The pairing-channel one-shot guard is
 * consumed here so a captured ciphertext can't be re-opened later.
 */
export function joinQrHandshakeOnTarget(
	inputs: QrJoinInputs,
	context: Partial<HandshakeContext> = {},
): QrJoinResult {
	const ctx = { ...DEFAULT_CONTEXT, ...context };
	const payload = decodeOrThrow(inputs.encodedPayload);
	if (payload.mode !== PairingMode.Qr) {
		throwInvalid(`payload mode must be ${PairingMode.Qr}, got ${payload.mode}`);
	}
	if (isPairingPayloadExpired(payload, ctx.now())) {
		const err = new Error("pairing payload expired");
		err.name = "Expired";
		throw err;
	}
	if (!inputs.guard.consume(payload.pairingSecret)) {
		const err = new Error("pairing channel already consumed");
		err.name = "Invalid";
		throw err;
	}
	const identitySecret = importSecretSealed(inputs.sealedIdentity, payload.pairingSecret);
	const derivedPub = ed25519GetPublicKey(identitySecret);
	if (!safeEqual(derivedPub, payload.userEd25519Pub)) {
		const err = new Error("decoded identity does not match payload userEd25519Pub");
		err.name = "Invalid";
		throw err;
	}

	return {
		identitySecret,
		userEd25519Pub: new Uint8Array(payload.userEd25519Pub),
		pairingSecret: payload.pairingSecret,
		relayUrl: payload.relayUrl,
		channelId: pairingChannelId(payload.pairingSecret),
		sas: deriveSas(payload.pairingSecret, SAS_INFO_QR_CONFIRM),
		sourceDeviceEd25519Pub: new Uint8Array(payload.sourceEd25519Pub),
	};
}

// --- SAS path -----------------------------------------------------------

export type SasEphemeral = {
	secretKey: Uint8Array;
	publicKey: Uint8Array;
};

export function newSasEphemeral(): SasEphemeral {
	const secretKey = new Uint8Array(randomBytes(32));
	const publicKey = new Uint8Array(x25519GetPublicKey(secretKey));
	return { secretKey, publicKey };
}

export type SasDerivation = {
	sas: string;
	pairingSecret: Uint8Array;
	channelId: string;
};

/**
 * Both SAS-mode devices compute the same `SasDerivation` from their own
 * secret + the peer's public ephemeral. The 6-digit `sas` is shown to the
 * user on both screens; on confirmation, A AEAD-seals the user-Ed25519
 * secret under `pairingSecret` and sends to B over the channel.
 */
export function deriveSasMaterial(ownSecret: Uint8Array, peerPublic: Uint8Array): SasDerivation {
	assertSecret("ownSecret", ownSecret);
	assertPubkey("peerPublic", peerPublic);
	const shared = new Uint8Array(x25519GetSharedSecret(ownSecret, peerPublic));
	const pairingSecret = new Uint8Array(hkdfSha256(shared, null, SECRET_HKDF_INFO, 32));
	const sas = deriveSas(shared, SAS_INFO_DEFAULT);
	const channelId = pairingChannelId(pairingSecret);
	return { sas, pairingSecret: new Uint8Array(pairingSecret), channelId };
}

// --- Source-side state machine (QR + SAS) -------------------------------

export type SourceMachineSnapshot = {
	state: PairingState;
	requestId: string;
	mode: PairingMode;
	sas: string | null;
	expiresAt: number | null;
	error: string | null;
};

export class SourcePairingMachine {
	private _state: PairingState = PairingState.Idle;
	private _sas: string | null = null;
	private _expiresAt: number | null = null;
	private _error: string | null = null;
	readonly requestId: string;
	readonly mode: PairingMode;

	constructor(opts: { requestId: string; mode: PairingMode }) {
		this.requestId = opts.requestId;
		this.mode = opts.mode;
	}

	get state(): PairingState {
		return this._state;
	}

	armedForJoin(opts: { sas: string; expiresAt: number }): void {
		this.transition(PairingState.WaitingForJoin);
		this._sas = opts.sas;
		this._expiresAt = opts.expiresAt;
	}

	handshakeStarted(): void {
		this.transition(PairingState.HandshakeInFlight);
	}

	paired(): void {
		this.transition(PairingState.Paired);
	}

	cancel(): void {
		if (this._state === PairingState.Paired) return;
		this.transition(PairingState.Cancelled);
	}

	expire(): void {
		if (this._state === PairingState.Paired || this._state === PairingState.Cancelled) {
			return;
		}
		this.transition(PairingState.Expired);
	}

	fail(reason: string): void {
		this._error = reason;
		this.transition(PairingState.Error);
	}

	snapshot(): SourceMachineSnapshot {
		return {
			state: this._state,
			requestId: this.requestId,
			mode: this.mode,
			sas: this._sas,
			expiresAt: this._expiresAt,
			error: this._error,
		};
	}

	private transition(next: PairingState): void {
		if (!isValidTransition(this._state, next)) {
			const err = new Error(`SourcePairingMachine: invalid transition ${this._state} → ${next}`);
			err.name = "Invalid";
			throw err;
		}
		this._state = next;
	}
}

// --- Target-side state machine ------------------------------------------

export class TargetPairingMachine {
	private _state: PairingState = PairingState.Idle;
	private _sas: string | null = null;
	private _expiresAt: number | null = null;
	private _error: string | null = null;
	readonly requestId: string;
	readonly mode: PairingMode;

	constructor(opts: { requestId: string; mode: PairingMode }) {
		this.requestId = opts.requestId;
		this.mode = opts.mode;
	}

	get state(): PairingState {
		return this._state;
	}

	beginScan(opts: { sas: string; expiresAt: number }): void {
		this.transition(PairingState.HandshakeInFlight);
		this._sas = opts.sas;
		this._expiresAt = opts.expiresAt;
	}

	paired(): void {
		this.transition(PairingState.Paired);
	}

	cancel(): void {
		if (this._state === PairingState.Paired) return;
		this.transition(PairingState.Cancelled);
	}

	expire(): void {
		if (this._state === PairingState.Paired || this._state === PairingState.Cancelled) {
			return;
		}
		this.transition(PairingState.Expired);
	}

	fail(reason: string): void {
		this._error = reason;
		this.transition(PairingState.Error);
	}

	snapshot(): SourceMachineSnapshot {
		return {
			state: this._state,
			requestId: this.requestId,
			mode: this.mode,
			sas: this._sas,
			expiresAt: this._expiresAt,
			error: this._error,
		};
	}

	private transition(next: PairingState): void {
		if (!isValidTransition(this._state, next)) {
			const err = new Error(`TargetPairingMachine: invalid transition ${this._state} → ${next}`);
			err.name = "Invalid";
			throw err;
		}
		this._state = next;
	}
}

function isValidTransition(from: PairingState, to: PairingState): boolean {
	if (from === to) return false;
	if (to === PairingState.Cancelled || to === PairingState.Expired || to === PairingState.Error) {
		return (
			from === PairingState.Idle ||
			from === PairingState.WaitingForJoin ||
			from === PairingState.HandshakeInFlight
		);
	}
	switch (from) {
		case PairingState.Idle:
			return to === PairingState.WaitingForJoin || to === PairingState.HandshakeInFlight;
		case PairingState.WaitingForJoin:
			return to === PairingState.HandshakeInFlight;
		case PairingState.HandshakeInFlight:
			return to === PairingState.Paired;
		case PairingState.Paired:
		case PairingState.Cancelled:
		case PairingState.Expired:
		case PairingState.Error:
			return false;
	}
}

function decodeOrThrow(encoded: string): PairingPayload {
	return decodePairingPayload(encoded);
}

function assertPubkey(name: string, value: Uint8Array): void {
	if (!(value instanceof Uint8Array) || value.length !== 32) {
		throwInvalid(`${name} must be a 32-byte Uint8Array`);
	}
}

function assertSecret(name: string, value: Uint8Array): void {
	if (!(value instanceof Uint8Array) || value.length !== IDENTITY_SECRET_BYTES) {
		throwInvalid(`${name} must be a ${IDENTITY_SECRET_BYTES}-byte Uint8Array`);
	}
}

function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= (a[i] as number) ^ (b[i] as number);
	}
	return diff === 0;
}

function throwInvalid(message: string): never {
	const err = new Error(`pairing-handshake: ${message}`);
	err.name = "Invalid";
	throw err;
}

export const __testing = {
	SECRET_HKDF_INFO,
	safeEqual,
};

export { base64UrlToBytes, bytesToBase64Url };
