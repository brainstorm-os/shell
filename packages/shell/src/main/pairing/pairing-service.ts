/**
 * Pairing IPC service (Stage 10.5a — headless layer).
 *
 * Surfaces the headless pairing protocol to the dashboard renderer (the
 * UI surface lands at 10.5b/c). Shell-internal only — no new default
 * capability grant; the broker's identity check on the dashboard
 * renderer is the authorisation.
 *
 *   Methods:
 *     - startAddDevice({ mode, deviceLabel })
 *           → { requestId, payload, sas, expiresAt, channelId }
 *
 *     - scanPayload({ payload, sealedIdentity })
 *           → { requestId, sas, channelId, expiresAt }
 *
 *     - confirmSas({ requestId })
 *           → { requestId, addedRecord }
 *
 *     - cancelPairing({ requestId })
 *           → { requestId, state }
 *
 *     - listDevices()
 *           → { records: SignedAddDeviceRecord[] }
 *
 *     - revokeDevice({ deviceEd25519Pub })
 *           → { revoked: boolean }
 *
 * `requestId` is shell-minted per `startAddDevice` / `scanPayload`. The
 * service caches per-request `{ machine, pairingSecret, ... }` until the
 * machine reaches a terminal state.
 */

import type { ServiceHandler } from "../../ipc/broker";
import type { Envelope } from "../../ipc/envelope";
import { type SealedSecret, isSealedSecret } from "../credentials/crypto";
import { PairingChannelGuard, exportSecretSealed } from "../credentials/identity-export";
import { type SignedAddDeviceRecord, signAddDeviceRecord } from "./devices-store";
import { base64UrlToBytes } from "./pairing-channel";
import {
	PairingState,
	type QrJoinResult,
	type SourceMachineSnapshot,
	SourcePairingMachine,
	TargetPairingMachine,
	joinQrHandshakeOnTarget,
	startQrHandshakeOnSource,
} from "./pairing-handshake";
import { PairingMode } from "./pairing-payload";

export type PairingServiceSession = {
	vaultId: string;
	getUserIdentity(): { publicKey: Uint8Array; secretKey: Uint8Array };
	getDeviceEd25519(): { publicKey: Uint8Array; secretKey: Uint8Array };
	getDeviceX25519(): { publicKey: Uint8Array };
	getRelayUrl(): string | null;
	saveIdentitySecret(secret: Uint8Array): Promise<void>;
	devicesAdd(record: SignedAddDeviceRecord): SignedAddDeviceRecord;
	devicesList(): SignedAddDeviceRecord[];
	devicesRevoke(deviceEd25519Pub: string, now?: number): boolean;
};

/**
 * Stage 10.5c — live-transport callbacks (the cross-device wire path).
 *
 * The IPC handler layer (`ipc/pairing-handlers.ts`) implements these
 * against the `ActiveRelayOrchestrator`'s current port. The service
 * itself is wire-agnostic — it drives the state machine + the crypto
 * sealing; the transport callbacks are the seam where the relay frames
 * cross.
 */
export type PairingServiceTransport = {
	/**
	 * Source-side: subscribe to a pairing channel and resolve with the
	 * first `JoinRequest` packet from the target. Implementation owns the
	 * relay subscription + timeout.
	 *
	 * Returns the target's pubkeys + label. The source seals identity
	 * under `pairingSecret` and calls `sendSealedIdentity` next.
	 */
	awaitJoinRequest(args: {
		channelId: string;
		pairingSecret: Uint8Array;
		sourceDeviceEd25519Pub: Uint8Array;
		expiresAt: number;
	}): Promise<{
		deviceEd25519Pub: string;
		deviceX25519Pub: string;
		deviceLabel: string;
	}>;
	/** Source → target: send the sealed identity over the channel. */
	sendSealedIdentity(args: {
		channelId: string;
		sealed: import("../credentials/crypto").SealedSecret;
		sourceDeviceEd25519Pub: Uint8Array;
		sourceDeviceEd25519Secret: Uint8Array;
	}): Promise<void>;
	/**
	 * Target-side: subscribe + send `JoinRequest`, then resolve with the
	 * source's sealed-identity packet. The renderer's scanPayload IPC
	 * drives this end-to-end before invoking the headless `joinQrHandshakeOnTarget`.
	 */
	requestSealedIdentity(args: {
		channelId: string;
		pairingSecret: Uint8Array;
		sourceDeviceEd25519Pub: Uint8Array;
		ownDeviceEd25519Pub: Uint8Array;
		ownDeviceEd25519Secret: Uint8Array;
		ownDeviceX25519Pub: Uint8Array;
		ownDeviceLabel: string;
		expiresAt: number;
	}): Promise<import("../credentials/crypto").SealedSecret>;
};

export type PairingServiceOptions = {
	getSession: () => Promise<PairingServiceSession | null>;
	/** Pluggable for tests. Defaults to a shared per-service guard. */
	channelGuard?: PairingChannelGuard;
	/** Pluggable for tests. Defaults to a counter-style ULID-ish id. */
	mintRequestId?: () => string;
	/** Injectable clock for tests. */
	now?: () => number;
	/** Stage 10.5c — live transport seam. Absent ⇒ `scanPayload` requires a
	 *  pre-fetched `sealedIdentity` (back-compat with 10.5b call sites + the
	 *  vanilla unit tests). Present ⇒ the service fetches the sealed
	 *  identity over the relay itself. */
	transport?: PairingServiceTransport;
};

type SourcePendingState = {
	kind: "source";
	machine: SourcePairingMachine;
	pairingSecret: Uint8Array;
	channelId: string;
};

type TargetPendingState = {
	kind: "target";
	machine: TargetPairingMachine;
	join: QrJoinResult;
};

type PendingState = SourcePendingState | TargetPendingState;

let internalCounter = 0;
function defaultMintRequestId(): string {
	internalCounter += 1;
	return `pair_${Date.now().toString(36)}_${internalCounter.toString(36)}`;
}

export class PairingService {
	private readonly options: PairingServiceOptions;
	private readonly guard: PairingChannelGuard;
	private readonly pending = new Map<string, PendingState>();

	constructor(options: PairingServiceOptions) {
		this.options = options;
		this.guard = options.channelGuard ?? new PairingChannelGuard();
	}

	async startAddDevice(args: {
		mode?: PairingMode;
		deviceLabel?: string;
	}): Promise<{
		requestId: string;
		payload: string;
		sas: string;
		expiresAt: number;
		channelId: string;
		mode: PairingMode;
	}> {
		const session = await this.requireSession();
		const mode = args.mode ?? PairingMode.Qr;
		if (mode !== PairingMode.Qr && mode !== PairingMode.Sas) {
			invalid(`unsupported pairing mode: ${String(mode)}`);
		}
		if (mode === PairingMode.Sas) {
			// Stage 10.5c — SAS mode requires the live transport to swap
			// ephemeral X25519 pubkeys before either side derives a SAS;
			// without a transport (test harness without one wired in) the
			// SAS path stays Unavailable. Once a transport is supplied we
			// still don't wire the full ECDH swap at 10.5c (out of scope —
			// pure SAS pairing is a `10.5d` follow-on); but the gate
			// upgrades from "no SAS ever" to "transport-aware Unavailable".
			const err = new Error(
				this.options.transport
					? "SAS mode requires the 10.5d follow-on (out of scope at 10.5c — QR live wire-up only)"
					: "SAS mode not supported at 10.5a (headless QR only)",
			);
			err.name = "Unavailable";
			throw err;
		}
		const relayUrl = session.getRelayUrl();
		if (!relayUrl) {
			const err = new Error("pairing requires a configured syncRelay on the vault");
			err.name = "Unavailable";
			throw err;
		}
		const identity = session.getUserIdentity();
		const deviceEd = session.getDeviceEd25519();
		const result = startQrHandshakeOnSource({
			userEd25519Pub: identity.publicKey,
			userEd25519Sec: identity.secretKey,
			sourceDeviceEd25519Pub: deviceEd.publicKey,
			relayUrl,
		});
		const requestId = (this.options.mintRequestId ?? defaultMintRequestId)();
		const machine = new SourcePairingMachine({ requestId, mode });
		machine.armedForJoin({ sas: result.sas, expiresAt: result.expiresAt });
		this.pending.set(requestId, {
			kind: "source",
			machine,
			pairingSecret: result.pairingSecret,
			channelId: result.channelId,
		});
		// Stage 10.5c — kick off the live wait for the target's JoinRequest
		// when a transport is wired. The transport awaits a JoinRequest
		// frame on the pairing channel, then we AEAD-seal the identity and
		// send a SealedIdentity frame back. Fire-and-forget — failures move
		// the state machine to Error; the caller polls via the existing
		// IPC surfaces (no new promise hangs).
		if (this.options.transport) {
			void this.driveSourceLiveHandshake(requestId).catch((error) => {
				// 10.9d step-2: silent throws from this async handshake are
				// the prime suspect for the soak pairing timeout — the only
				// observable was that no SealedIdentity ever hit the wire.
				// Log AT THE THROW so the soak's stderr capture surfaces it.
				if (process.env.BRAINSTORM_SOAK_DEBUG === "1") {
					console.error(
						`[pairing/debug] driveSourceLiveHandshake threw: ${(error as Error).stack ?? (error as Error).message}`,
					);
				}
				const pending = this.pending.get(requestId);
				if (pending && pending.kind === "source") {
					try {
						pending.machine.fail((error as Error).message);
					} catch {
						// Already terminal — fine.
					}
				}
			});
		}
		return {
			requestId,
			payload: result.payload,
			sas: result.sas,
			expiresAt: result.expiresAt,
			channelId: result.channelId,
			mode,
		};
	}

	/**
	 * Stage 10.5c — drive the source-side live handshake. Awaits the
	 * target's JoinRequest from the transport, AEAD-seals the user-identity
	 * secret under `pairingSecret`, and sends a SealedIdentity frame back.
	 * The state machine moves `WaitingForJoin → HandshakeInFlight → Paired`
	 * as each milestone lands; the source side does NOT add a devices
	 * record on its own — `confirmSas` on the target side (which arrives
	 * via the live relay too, but as the Yjs `meta.devices` append) is the
	 * authoritative add-device path.
	 */
	private async driveSourceLiveHandshake(requestId: string): Promise<void> {
		const session = await this.requireSession();
		const pending = this.pending.get(requestId);
		if (!pending || pending.kind !== "source") return;
		const transport = this.options.transport;
		if (!transport) return;
		const identity = session.getUserIdentity();
		const deviceEd = session.getDeviceEd25519();
		const expiresAt =
			pending.machine.snapshot().expiresAt ?? (this.options.now ?? Date.now)() + 120_000;
		const join = await transport.awaitJoinRequest({
			channelId: pending.channelId,
			pairingSecret: pending.pairingSecret,
			sourceDeviceEd25519Pub: deviceEd.publicKey,
			expiresAt,
		});
		// Move to HandshakeInFlight on actual contact. The target's
		// confirmSas in turn flips Paired on its end; the source side
		// reflects Paired once it has sent the sealed identity.
		const stillPending = this.pending.get(requestId);
		if (!stillPending || stillPending.kind !== "source") return;
		if (stillPending.machine.state === PairingState.WaitingForJoin) {
			stillPending.machine.handshakeStarted();
		}
		const sealed = exportSecretSealed(identity.secretKey, pending.pairingSecret);
		await transport.sendSealedIdentity({
			channelId: pending.channelId,
			sealed,
			sourceDeviceEd25519Pub: deviceEd.publicKey,
			sourceDeviceEd25519Secret: deviceEd.secretKey,
		});
		// Record the new device on the source's own meta.devices array
		// immediately — the target will independently sign + post one
		// when it confirms SAS; the two records are idempotent by
		// deviceEd25519Pub (DevicesStore.add). v1 is single-user so the
		// records converge identically regardless of which device wins.
		const record = signAddDeviceRecord(
			{
				deviceEd25519Pub: bytesToBase64(base64UrlToBytes(join.deviceEd25519Pub)),
				deviceX25519Pub: bytesToBase64(base64UrlToBytes(join.deviceX25519Pub)),
				deviceLabel: join.deviceLabel,
				addedAt: (this.options.now ?? Date.now)(),
				addedBy: bytesToBase64(identity.publicKey),
			},
			identity.secretKey,
		);
		session.devicesAdd(record);
		// P2P-1 — record OUR OWN device too. Neither side used to do this, so a
		// freshly-paired source knew the joiner but not itself, and a device that
		// is not in its own roster cannot be admitted by its own LAN listener —
		// which is how the hosting device joins the session it is hosting.
		try {
			const deviceX = session.getDeviceX25519();
			session.devicesAdd(
				signAddDeviceRecord(
					{
						deviceEd25519Pub: bytesToBase64(deviceEd.publicKey),
						deviceX25519Pub: bytesToBase64(deviceX.publicKey),
						deviceLabel: "",
						addedAt: (this.options.now ?? Date.now)(),
						addedBy: bytesToBase64(identity.publicKey),
					},
					identity.secretKey,
				),
			);
		} catch (error) {
			console.warn("[pairing] could not record this device:", error);
		}
		if (stillPending.machine.state === PairingState.HandshakeInFlight) {
			stillPending.machine.paired();
		}
	}

	async scanPayload(args: {
		payload: string;
		sealedIdentity: SealedSecret;
	}): Promise<{
		requestId: string;
		sas: string;
		channelId: string;
		expiresAt: number;
		mode: PairingMode;
	}> {
		const session = await this.requireSession();
		if (typeof args.payload !== "string" || args.payload.length === 0) {
			invalid("payload must be a non-empty string");
		}
		if (!isSealedSecret(args.sealedIdentity)) {
			invalid("sealedIdentity must be a SealedSecret");
		}
		const join = joinQrHandshakeOnTarget({
			encodedPayload: args.payload,
			sealedIdentity: args.sealedIdentity,
			guard: this.guard,
		});

		await session.saveIdentitySecret(join.identitySecret);
		zero(join.identitySecret);

		const requestId = (this.options.mintRequestId ?? defaultMintRequestId)();
		const machine = new TargetPairingMachine({ requestId, mode: PairingMode.Qr });
		const expiresAt = (this.options.now ?? (() => Math.floor(Date.now() / 1000)))() + 120;
		machine.beginScan({ sas: join.sas, expiresAt });
		this.pending.set(requestId, { kind: "target", machine, join });
		return {
			requestId,
			sas: join.sas,
			channelId: join.channelId,
			expiresAt,
			mode: PairingMode.Qr,
		};
	}

	async confirmSas(args: { requestId: string }): Promise<{
		requestId: string;
		addedRecord: SignedAddDeviceRecord;
	}> {
		const session = await this.requireSession();
		if (typeof args.requestId !== "string" || args.requestId.length === 0) {
			invalid("requestId must be a non-empty string");
		}
		const pending = this.pending.get(args.requestId);
		if (!pending) {
			invalid(`unknown pairing requestId: ${args.requestId}`);
		}
		if (pending.kind !== "target") {
			invalid(`requestId ${args.requestId} is not a target-side pairing`);
		}
		if (pending.machine.state !== PairingState.HandshakeInFlight) {
			invalid(`pairing ${args.requestId} is in state ${pending.machine.state}`);
		}

		const identity = session.getUserIdentity();
		const deviceEd = session.getDeviceEd25519();
		const deviceX = session.getDeviceX25519();
		const record = signAddDeviceRecord(
			{
				deviceEd25519Pub: bytesToBase64(deviceEd.publicKey),
				deviceX25519Pub: bytesToBase64(deviceX.publicKey),
				deviceLabel: "",
				addedAt: (this.options.now ?? Date.now)(),
				addedBy: bytesToBase64(identity.publicKey),
			},
			identity.secretKey,
		);
		const stored = session.devicesAdd(record);
		// P2P-1 — also record the device we just paired WITH. Without this the
		// pair is asymmetric: the source records the joiner, the joiner records
		// only itself, and nothing ever teaches the joiner who the source is.
		// The LAN client refuses a host that is not in its own roster, so two
		// paired machines could never admit each other and every dial fell back
		// to the relay. Idempotent by `deviceEd25519Pub`, like every other add.
		//
		// Only the source's Ed25519 travels in the QR payload, which is all a
		// CLIENT needs (it verifies the host's proof under that key). Sealing a
		// challenge additionally needs the peer's X25519, so this device cannot
		// yet act as HOST for the source; that direction wants the source's
		// X25519 on the wire and is its own rung.
		try {
			session.devicesAdd(
				signAddDeviceRecord(
					{
						deviceEd25519Pub: bytesToBase64(pending.join.sourceDeviceEd25519Pub),
						// Only the source's Ed25519 travels in the QR payload; see the
						// note in `DevicesStore.add` on why empty is legitimate here.
						deviceX25519Pub: "",
						deviceLabel: "",
						addedAt: (this.options.now ?? Date.now)(),
						addedBy: bytesToBase64(identity.publicKey),
					},
					identity.secretKey,
				),
			);
		} catch (error) {
			// A failure here must not undo a completed pairing — the user is
			// paired either way; only LAN admission is degraded.
			console.warn("[pairing] could not record the source device:", error);
		}
		pending.machine.paired();
		return { requestId: args.requestId, addedRecord: stored };
	}

	async cancelPairing(args: { requestId: string }): Promise<{
		requestId: string;
		state: PairingState;
	}> {
		const pending = this.pending.get(args.requestId);
		if (!pending) {
			invalid(`unknown pairing requestId: ${args.requestId}`);
		}
		if (pending.kind === "source") {
			pending.machine.cancel();
		} else {
			pending.machine.cancel();
		}
		const snapshot: SourceMachineSnapshot =
			pending.kind === "source" ? pending.machine.snapshot() : pending.machine.snapshot();
		return { requestId: args.requestId, state: snapshot.state };
	}

	async listDevices(): Promise<{ records: SignedAddDeviceRecord[] }> {
		const session = await this.requireSession();
		return { records: session.devicesList() };
	}

	async revokeDevice(args: { deviceEd25519Pub: string }): Promise<{ revoked: boolean }> {
		const session = await this.requireSession();
		if (typeof args.deviceEd25519Pub !== "string" || args.deviceEd25519Pub.length === 0) {
			invalid("deviceEd25519Pub must be a non-empty string");
		}
		const ok = session.devicesRevoke(args.deviceEd25519Pub, (this.options.now ?? Date.now)());
		return { revoked: ok };
	}

	pendingRequestCount(): number {
		return this.pending.size;
	}

	private async requireSession(): Promise<PairingServiceSession> {
		const session = await this.options.getSession();
		if (!session) {
			const err = new Error("pairing service requires an active vault session");
			err.name = "Unavailable";
			throw err;
		}
		return session;
	}
}

export type PairingServiceHandlerOptions = {
	getService: () => Promise<PairingService | null>;
};

const KNOWN_METHODS = new Set([
	"startAddDevice",
	"scanPayload",
	"confirmSas",
	"cancelPairing",
	"listDevices",
	"revokeDevice",
]);

export function makePairingServiceHandler(options: PairingServiceHandlerOptions): ServiceHandler {
	return async (envelope: Envelope): Promise<unknown> => {
		const svc = await options.getService();
		if (!svc) {
			const err = new Error("pairing service is not available (no active vault session)");
			err.name = "Unavailable";
			throw err;
		}
		if (!KNOWN_METHODS.has(envelope.method)) {
			invalid(`unknown pairing method: ${envelope.method}`);
		}
		const [arg] = envelope.args as [unknown];
		const payload = (arg ?? {}) as Record<string, unknown>;
		switch (envelope.method) {
			case "startAddDevice": {
				const args: { mode?: PairingMode; deviceLabel?: string } = {};
				if (payload.mode !== undefined) args.mode = payload.mode as PairingMode;
				if (typeof payload.deviceLabel === "string") {
					args.deviceLabel = payload.deviceLabel;
				}
				return await svc.startAddDevice(args);
			}
			case "scanPayload":
				return await svc.scanPayload({
					payload: payload.payload as string,
					sealedIdentity: payload.sealedIdentity as SealedSecret,
				});
			case "confirmSas":
				return await svc.confirmSas({ requestId: payload.requestId as string });
			case "cancelPairing":
				return await svc.cancelPairing({ requestId: payload.requestId as string });
			case "listDevices":
				return await svc.listDevices();
			case "revokeDevice":
				return await svc.revokeDevice({
					deviceEd25519Pub: payload.deviceEd25519Pub as string,
				});
			default:
				invalid(`unhandled pairing method: ${envelope.method}`);
		}
	};
}

function invalid(message: string): never {
	const err = new Error(message);
	err.name = "Invalid";
	throw err;
}

function bytesToBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}

function zero(buffer: Uint8Array): void {
	for (let i = 0; i < buffer.length; i++) buffer[i] = 0;
}
