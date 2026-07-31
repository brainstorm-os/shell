/**
 * `pairing:*` IPC handlers — the privileged dashboard surface that powers
 * the Settings → Devices section + first-launch join-vault entry (Stage
 * 10.5b — pairing UX). Mirrors the `files-handles:*` pattern:
 *
 *   - Apps never call these; the dashboard renderer is the only renderer
 *     allowed to drive pairing because it's the Settings UI.
 *   - The `PairingService` is constructed lazily from the active
 *     `VaultSession` so its lifetime is the session's, not the app's.
 *   - Each method is a thin shim that translates IPC args into the service
 *     surface; the service owns the state machines + crypto.
 *
 * The plaintext identity secret never crosses IPC — `PairingService.scanPayload`
 * unseals + saves it on the main side (sealed-export pattern from 10.5a).
 *
 * Change notifications: `app:pairing-devices-changed` is a payload-free
 * staleness signal the dashboard subscribes to; the handler re-`listDevices`
 * through the authoritative path. Fires on every successful pair/revoke;
 * future cross-device propagation (10.5c+) will fire it on remote-added
 * record arrivals too.
 */

import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import { XCHACHA_NONCE_BYTES, bytesToBase64, isSealedSecret } from "../credentials/crypto";
import { base64UrlToBytes, bytesToBase64Url, pairingChannelId } from "../pairing/pairing-channel";
// Used implicitly through the live transport seam — keeping the import
// site explicit makes the relay-blind audit + reviewer scanning easier.
import {
	PairingFrameType,
	decodePairingFrame,
	encodePairingFrame,
	verifyPairingFrame,
} from "../pairing/pairing-frame";
import { PairingMode } from "../pairing/pairing-payload";
import {
	PairingService,
	type PairingServiceSession,
	type PairingServiceTransport,
} from "../pairing/pairing-service";
import { getActiveRelay } from "../sync/active-relay";
import {
	type VaultSession,
	getActiveVaultSession,
	onActiveVaultSessionChanged,
} from "../vault/session";
import {
	type VaultPropertiesStore,
	VaultPropertiesStore as VaultPropertiesStoreClass,
} from "../vault/vault-properties-store";

export const APP_PAIRING_DEVICES_CHANGED_CHANNEL = "app:pairing-devices-changed";

export type PairingHandlersOptions = {
	/** The dashboard window — the only renderer that should receive the
	 *  change signal. Same pattern `files-handles-handlers.ts` uses. */
	getDashboard: () => BrowserWindow | null;
	/**
	 * P2P-1 — the devices roster changed (a device was paired in, or revoked).
	 *
	 * The LAN handshake authenticates against a roster the main process reads
	 * ONCE per vault change, but pairing happens while the vault is already
	 * open. Without this the host kept the empty pre-pairing roster and refused
	 * to seal a challenge for the device that had just joined, so two paired
	 * machines could never admit each other and every LAN dial fell back to the
	 * relay. Revocation needs the same signal, in the other direction.
	 */
	onDevicesChanged?: (
		activeRecords: readonly { deviceEd25519Pub: string; deviceX25519Pub?: string }[],
	) => void;
	/**
	 * LAN-3's PRODUCING half — the live LAN listener URL, or `null`.
	 *
	 * `LAN-3` shipped only the accepting half. `LanRelayListener` has always
	 * minted exactly the URL the pairing payload wants (`LanListenerAddress.url`,
	 * commented as such) and `pairing-payload.ts` has always validated and
	 * accepted a `ws://` address behind the scheme allowlist — but nothing
	 * connected the two, so `LanHostController.onUrlChanged`'s only production
	 * consumer was a `console.info`. With this, the payload a hosting device
	 * hands out carries its own private address, and the just-paired device
	 * adopts it as a LAN peer with no discovery on the critical path.
	 *
	 * **The relay in `vault.json` still WINS when one is configured, and that
	 * ordering is load-bearing.** The pairing exchange itself rides the local
	 * transport, and the LAN transport's channel-bound admission refuses a
	 * device that is not yet on the roster — which a device being paired is not,
	 * by definition. So the LAN URL cannot carry the exchange; it is the address
	 * to sync with AFTERWARDS. Preferring it would turn a working relay pairing
	 * into one that hangs. It fills the slot only when there is no relay at all,
	 * where the alternative is an empty payload.
	 */
	getLanListenerUrl?: () => string | null;
	/**
	 * LAN-3 — the source's address, as carried by a payload we just joined
	 * with. The wiring offers it to the LAN dial coordinator so a just-paired
	 * device can reach its peer directly without waiting for discovery. A
	 * non-LAN address is filtered downstream.
	 */
	onPairedPeerUrl?: (url: string) => void;
};

type ActiveServiceHolder = {
	session: VaultSession;
	props: VaultPropertiesStore;
	service: PairingService;
} | null;

async function readVaultSyncRelayUrl(vaultPath: string): Promise<string | null> {
	try {
		const raw = await readFile(join(vaultPath, "vault.json"), "utf8");
		const parsed = JSON.parse(raw) as { syncRelay?: { url?: unknown } };
		if (
			parsed.syncRelay &&
			typeof parsed.syncRelay === "object" &&
			typeof parsed.syncRelay.url === "string" &&
			parsed.syncRelay.url.length > 0
		) {
			return parsed.syncRelay.url;
		}
		return null;
	} catch {
		return null;
	}
}

function buildSession(
	session: VaultSession,
	props: VaultPropertiesStore,
	/** Read per call, not captured: the LAN listener's port is ephemeral and the
	 *  listener can start or stop between one pairing and the next. */
	relayUrl: () => string | null,
	notify: () => void,
): PairingServiceSession {
	const devicesStore = props.devices();
	const identityProvider = session.exposeIdentityForPairing();
	return {
		vaultId: session.vaultId,
		getUserIdentity: () => ({
			publicKey: identityProvider.publicKey,
			secretKey: identityProvider.secretKey,
		}),
		getDeviceEd25519: () => ({
			publicKey: identityProvider.deviceEd25519Public,
			secretKey: identityProvider.deviceEd25519Secret,
		}),
		getDeviceX25519: () => ({
			publicKey: identityProvider.deviceX25519Public,
		}),
		getRelayUrl: relayUrl,
		saveIdentitySecret: async (secret: Uint8Array): Promise<void> => {
			// Stage 10.5c — install the unsealed user-identity secret into
			// the keystore on the target side. The same keystore backend
			// the session uses (`session.backend`) gets a `setSecret(...,
			// "identity", secret)` write; the next `VaultSession.open` on
			// this device reads it back and verifies the public key against
			// the vault.json record (which the pre-pairing target vault's
			// `expectedPublicKeyBase64` will need to match — but in v1 the
			// target's vault.json is the same logical vault as the source's,
			// just opened on a different device after the user copies it
			// across, so the keys match by construction once the user
			// re-opens with the freshly-installed identity).
			await session.backend.setSecret(session.vaultId, "identity", secret);
		},
		devicesAdd: (record) => {
			const stored = devicesStore.add(record);
			notify();
			return stored;
		},
		devicesList: () => devicesStore.list(),
		devicesRevoke: (deviceEd25519Pub, now) => {
			const ok = devicesStore.revoke(deviceEd25519Pub, now);
			if (ok) notify();
			return ok;
		},
	};
}

/**
 * Stage 10.5c — build the `PairingServiceTransport` against the live
 * `ActiveRelayOrchestrator` port. The transport routes pairing frames
 * through the relay using the `pairingChannelId` as the routing-header
 * entityId; the relay's blind-router treats them identically to any
 * other entity frame.
 *
 * The transport is constructed once per `ensureActive` call so the port
 * reference is fresh on every session change; in-flight awaits are
 * scoped to a single channel and tied to a timeout derived from the
 * pairing payload's `expiresAt`.
 */
function buildTransport(): PairingServiceTransport {
	const PAIRING_AWAIT_TIMEOUT_MS = 120_000;
	// 10.9d step-2 instrumentation: env-gated debug logging so the soak
	// harness can trace the SealedIdentity hand-off without cluttering
	// production logs. Off by default.
	const debugLog = process.env.BRAINSTORM_SOAK_DEBUG === "1";
	const freshNonce24 = (): string => {
		const n = new Uint8Array(XCHACHA_NONCE_BYTES);
		crypto.getRandomValues(n);
		return bytesToBase64(n);
	};
	return {
		awaitJoinRequest: ({ channelId, sourceDeviceEd25519Pub: _src, expiresAt }) => {
			const relay = getActiveRelay();
			if (!relay) throw unavailable("pairing transport requires an active relay");
			return new Promise((resolve, reject) => {
				let settled = false;
				const port = relay.currentPort();
				if (debugLog) {
					console.info(
						`[pairing/debug] awaitJoinRequest start channelId=${channelId} expiresAt=${expiresAt}`,
					);
				}
				const onFrame = (frame: Uint8Array): void => {
					if (settled) return;
					if (debugLog) {
						console.info(
							`[pairing/debug] awaitJoinRequest onFrame channelId=${channelId} bytes=${frame.length}`,
						);
					}
					let decoded: ReturnType<typeof decodePairingFrame>;
					try {
						decoded = decodePairingFrame(frame);
					} catch (error) {
						if (debugLog) {
							console.info(`[pairing/debug] awaitJoinRequest decode-fail: ${(error as Error).message}`);
						}
						return;
					}
					if (debugLog) {
						console.info(
							`[pairing/debug] awaitJoinRequest decoded type=${decoded.body.type} headerEntityId=${decoded.header.entityId} want=${channelId}`,
						);
					}
					if (decoded.header.entityId !== channelId) return;
					if (decoded.body.type !== PairingFrameType.JoinRequest) return;
					const claimedSenderBytes = base64UrlToBytes(decoded.body.deviceEd25519Pub);
					if (claimedSenderBytes.length !== 32) return;
					// TOFU verify against the self-carried pubkey in the
					// body (the source learns the target's pubkey on this
					// channel for the first time here; the pairingSecret
					// one-shot guard + SAS-confirm gate any tampering).
					if (!verifyPairingFrame(decoded, claimedSenderBytes)) return;
					settled = true;
					port.offFrame(onFrame);
					relay.unsubscribe(channelId);
					clearTimeout(timer);
					resolve({
						deviceEd25519Pub: decoded.body.deviceEd25519Pub,
						deviceX25519Pub: decoded.body.deviceX25519Pub,
						deviceLabel: decoded.body.deviceLabel,
					});
				};
				const timeoutMs = Math.max(
					1_000,
					Math.min(PAIRING_AWAIT_TIMEOUT_MS, Math.floor((expiresAt - Date.now() / 1000) * 1000)),
				);
				const timer = setTimeout(() => {
					if (settled) return;
					settled = true;
					port.offFrame(onFrame);
					relay.unsubscribe(channelId);
					const err = new Error("pairing: timed out awaiting target JoinRequest");
					err.name = "Expired";
					reject(err);
				}, timeoutMs);
				port.onFrame(onFrame);
				relay.subscribe(channelId);
				if (debugLog) {
					console.info(
						`[pairing/debug] awaitJoinRequest subscribed channelId=${channelId}; waiting for JoinRequest`,
					);
				}
			});
		},
		sendSealedIdentity: async ({
			channelId,
			sealed,
			sourceDeviceEd25519Pub,
			sourceDeviceEd25519Secret,
		}) => {
			const relay = getActiveRelay();
			if (!relay) throw unavailable("pairing transport requires an active relay");
			const sealedJson = Buffer.from(JSON.stringify(sealed), "utf8").toString("base64");
			const frame = encodePairingFrame({
				channelId,
				body: {
					type: PairingFrameType.SealedIdentity,
					sealed: sealedJson,
					sourceDeviceEd25519Pub: bytesToBase64Url(sourceDeviceEd25519Pub),
				},
				deviceEd25519Pub: sourceDeviceEd25519Pub,
				deviceEd25519Secret: sourceDeviceEd25519Secret,
				seq: 0,
				nowMs: Date.now(),
				nonce: freshNonce24(),
			});
			if (debugLog) {
				console.info(
					`[pairing/debug] sendSealedIdentity channelId=${channelId} frameBytes=${frame.length}`,
				);
			}
			relay.currentPort().send(frame);
		},
		requestSealedIdentity: ({
			channelId,
			sourceDeviceEd25519Pub,
			ownDeviceEd25519Pub,
			ownDeviceEd25519Secret,
			ownDeviceX25519Pub,
			ownDeviceLabel,
			expiresAt,
		}) => {
			const relay = getActiveRelay();
			if (!relay) throw unavailable("pairing transport requires an active relay");
			return new Promise((resolve, reject) => {
				let settled = false;
				const port = relay.currentPort();
				if (debugLog) {
					console.info(
						`[pairing/debug] requestSealedIdentity start channelId=${channelId} expiresAt=${expiresAt}`,
					);
				}
				const onFrame = (frame: Uint8Array): void => {
					if (settled) return;
					if (debugLog) {
						console.info(
							`[pairing/debug] requestSealedIdentity onFrame channelId=${channelId} bytes=${frame.length}`,
						);
					}
					let decoded: ReturnType<typeof decodePairingFrame>;
					try {
						decoded = decodePairingFrame(frame);
					} catch (error) {
						if (debugLog) {
							console.info(
								`[pairing/debug] requestSealedIdentity decode-fail: ${(error as Error).message}`,
							);
						}
						return;
					}
					if (debugLog) {
						console.info(
							`[pairing/debug] requestSealedIdentity decoded type=${decoded.body.type} headerEntityId=${decoded.header.entityId} want=${channelId}`,
						);
					}
					if (decoded.header.entityId !== channelId) return;
					if (decoded.body.type !== PairingFrameType.SealedIdentity) return;
					// Verify the source's signature using the pubkey the
					// QR payload carried — this is the moment the target's
					// trust assumption ("the QR I scanned is from a
					// genuine device of mine") finally meets a cryptographic
					// check on the wire.
					if (!verifyPairingFrame(decoded, sourceDeviceEd25519Pub)) return;
					settled = true;
					port.offFrame(onFrame);
					relay.unsubscribe(channelId);
					clearTimeout(timer);
					try {
						const parsed = JSON.parse(
							Buffer.from(decoded.body.sealed, "base64").toString("utf8"),
						) as unknown;
						if (!isSealedSecret(parsed)) {
							reject(invalid("pairing: source-sent payload is not a SealedSecret"));
							return;
						}
						resolve(parsed);
					} catch (error) {
						reject(invalid(`pairing: failed to parse sealed payload (${(error as Error).message})`));
					}
				};
				const timeoutMs = Math.max(
					1_000,
					Math.min(PAIRING_AWAIT_TIMEOUT_MS, Math.floor((expiresAt - Date.now() / 1000) * 1000)),
				);
				const timer = setTimeout(() => {
					if (settled) return;
					settled = true;
					port.offFrame(onFrame);
					relay.unsubscribe(channelId);
					const err = new Error("pairing: timed out awaiting source SealedIdentity");
					err.name = "Expired";
					reject(err);
				}, timeoutMs);
				port.onFrame(onFrame);
				relay.subscribe(channelId);
				if (debugLog) {
					console.info(
						`[pairing/debug] requestSealedIdentity subscribed channelId=${channelId}; about to send JoinRequest`,
					);
				}
				// Send the JoinRequest after subscribing so a fast source
				// can't miss the channel join → reply window.
				const joinFrame = encodePairingFrame({
					channelId,
					body: {
						type: PairingFrameType.JoinRequest,
						deviceEd25519Pub: bytesToBase64Url(ownDeviceEd25519Pub),
						deviceX25519Pub: bytesToBase64Url(ownDeviceX25519Pub),
						deviceLabel: ownDeviceLabel,
					},
					deviceEd25519Pub: ownDeviceEd25519Pub,
					deviceEd25519Secret: ownDeviceEd25519Secret,
					seq: 0,
					nowMs: Date.now(),
					nonce: freshNonce24(),
				});
				port.send(joinFrame);
				if (debugLog) {
					console.info(
						`[pairing/debug] requestSealedIdentity sent JoinRequest channelId=${channelId} frameBytes=${joinFrame.length}`,
					);
				}
			});
		},
	};
}

/**
 * Register the privileged pairing IPC + cross-vault subscription wiring.
 * Returns a disposer that unhooks listeners + closes the cached
 * vault-properties doc on shutdown or vault close.
 */
export function registerPairingHandlers(options: PairingHandlersOptions): () => void {
	let active: ActiveServiceHolder = null;

	const notify = (): void => {
		try {
			// Hand over THIS store's live rows rather than letting the listener
			// re-open its own `VaultPropertiesStore`: a second `open()` loads a
			// separate Y.Doc handle for the same id, so it cannot see a write that
			// has only happened in this one. That is precisely why re-reading the
			// roster after pairing still reported zero devices.
			options.onDevicesChanged?.(active?.props.devices().listActive() ?? []);
		} catch (error) {
			console.warn("[brainstorm] pairing-devices main-process hook failed:", error);
		}
		const dashboard = options.getDashboard();
		if (!dashboard || dashboard.isDestroyed()) return;
		try {
			dashboard.webContents.send(APP_PAIRING_DEVICES_CHANGED_CHANNEL);
		} catch (error) {
			console.warn("[brainstorm] pairing-devices change broadcast failed:", error);
		}
	};

	const closeActive = async (): Promise<void> => {
		if (!active) return;
		const props = active.props;
		active = null;
		await props.close().catch(() => {});
	};

	const ensureActive = async (): Promise<ActiveServiceHolder> => {
		const session = getActiveVaultSession();
		if (!session) {
			await closeActive();
			return null;
		}
		if (active && active.session === session) return active;
		await closeActive();
		const props = await VaultPropertiesStoreClass.open(session.ydocStore);
		// LAN-3 — the listener URL wins when we are hosting. Read through a
		// getter rather than captured, because the port is ephemeral and the
		// listener can start or stop between one pairing and the next.
		const vaultRelayUrl = await readVaultSyncRelayUrl(session.vaultPath);
		// Relay first, LAN listener as the fallback — see `getLanListenerUrl`.
		const relayUrl = (): string | null => vaultRelayUrl ?? options.getLanListenerUrl?.() ?? null;
		const service = new PairingService({
			getSession: async () => buildSession(session, props, relayUrl, notify),
			transport: buildTransport(),
		});
		active = { session, props, service };
		return active;
	};

	const unsubscribeSession = onActiveVaultSessionChanged(() => {
		void closeActive();
	});

	ipcMain.handle(
		"pairing:start-add-device",
		async (
			_event,
			args: { mode?: PairingMode; deviceLabel?: string } | undefined,
		): Promise<unknown> => {
			const holder = await ensureActive();
			if (!holder) throw unavailable("pairing requires an active vault session");
			const passed = args ?? {};
			const startArgs: { mode?: PairingMode; deviceLabel?: string } = {};
			if (passed.mode === PairingMode.Qr || passed.mode === PairingMode.Sas) {
				startArgs.mode = passed.mode;
			}
			if (typeof passed.deviceLabel === "string") startArgs.deviceLabel = passed.deviceLabel;
			return holder.service.startAddDevice(startArgs);
		},
	);

	ipcMain.handle(
		"pairing:scan-payload",
		async (_event, args: { payload: string }): Promise<unknown> => {
			const holder = await ensureActive();
			if (!holder) throw unavailable("pairing requires an active vault session");
			if (!args || typeof args.payload !== "string" || args.payload.length === 0) {
				throw invalid("payload must be a non-empty string");
			}
			// Stage 10.5c — fetch the sealed identity over the live relay
			// from the source side. The renderer's scanPayload IPC is the
			// single roundtrip on the target end; this handler:
			//   1. decodes the QR payload to derive `pairingChannelId` +
			//      pairingSecret + sourceDeviceEd25519Pub + relayUrl.
			//   2. drives `transport.requestSealedIdentity` to send a
			//      JoinRequest frame, then wait for the source's
			//      SealedIdentity reply.
			//   3. invokes the service's `scanPayload` with the freshly
			//      fetched sealed identity to run the existing unseal +
			//      install path.
			try {
				const { decodePairingPayload } = await import("../pairing/pairing-payload");
				const payloadDecoded = decodePairingPayload(args.payload);
				const channelId = pairingChannelId(payloadDecoded.pairingSecret);
				const session = getActiveVaultSession();
				if (!session) throw unavailable("pairing requires an active vault session");
				const identityProvider = session.exposeIdentityForPairing();
				const transport = buildTransport();
				const sealedIdentity = await transport.requestSealedIdentity({
					channelId,
					pairingSecret: payloadDecoded.pairingSecret,
					sourceDeviceEd25519Pub: payloadDecoded.sourceEd25519Pub,
					ownDeviceEd25519Pub: identityProvider.deviceEd25519Public,
					ownDeviceEd25519Secret: identityProvider.deviceEd25519Secret,
					ownDeviceX25519Pub: identityProvider.deviceX25519Public,
					ownDeviceLabel: "",
					expiresAt: payloadDecoded.expiresAt,
				});
				const joined = await holder.service.scanPayload({
					payload: args.payload,
					sealedIdentity,
				});
				// LAN-3 — the payload's address is now OURS to sync with. Provenance,
				// not address inference (F-466): this URL arrived inside a payload the
				// user physically transferred and whose sealed identity we just
				// opened, which is a stronger warrant than any discovery advert. The
				// coordinator still refuses it unless the user has LAN dialling on.
				options.onPairedPeerUrl?.(payloadDecoded.relayUrl);
				return joined;
			} catch (error) {
				throw wrapError(error);
			}
		},
	);

	ipcMain.handle(
		"pairing:confirm-sas",
		async (_event, args: { requestId: string }): Promise<unknown> => {
			const holder = await ensureActive();
			if (!holder) throw unavailable("pairing requires an active vault session");
			if (!args || typeof args.requestId !== "string" || args.requestId.length === 0) {
				throw invalid("requestId must be a non-empty string");
			}
			try {
				return await holder.service.confirmSas(args);
			} catch (error) {
				throw wrapError(error);
			}
		},
	);

	ipcMain.handle("pairing:cancel", async (_event, args: { requestId: string }): Promise<unknown> => {
		const holder = await ensureActive();
		if (!holder) throw unavailable("pairing requires an active vault session");
		if (!args || typeof args.requestId !== "string" || args.requestId.length === 0) {
			throw invalid("requestId must be a non-empty string");
		}
		try {
			return await holder.service.cancelPairing(args);
		} catch (error) {
			throw wrapError(error);
		}
	});

	ipcMain.handle("pairing:list-devices", async (): Promise<{ records: unknown[] }> => {
		const holder = await ensureActive();
		if (!holder) return { records: [] };
		return holder.service.listDevices();
	});

	ipcMain.handle(
		"pairing:revoke-device",
		async (_event, args: { deviceEd25519Pub: string }): Promise<unknown> => {
			const holder = await ensureActive();
			if (!holder) throw unavailable("pairing requires an active vault session");
			if (!args || typeof args.deviceEd25519Pub !== "string") {
				throw invalid("deviceEd25519Pub must be a non-empty string");
			}
			return holder.service.revokeDevice(args);
		},
	);

	ipcMain.handle("pairing:this-device", async (): Promise<string | null> => {
		const session = getActiveVaultSession();
		if (!session) return null;
		return session.deviceEd25519.publicKeyBase64;
	});

	ipcMain.handle("pairing:has-relay", async (): Promise<boolean> => {
		const session = getActiveVaultSession();
		if (!session) return false;
		// LAN-3 — a device hosting on the local network has a reachable address
		// even with no relay configured, so "Add device" must not be disabled.
		// Without this a LAN-only setup can never pair a second device, which is
		// precisely the setup this rung exists to make usable.
		const url = await readVaultSyncRelayUrl(session.vaultPath);
		if (url !== null) return true;
		// A device hosting on the local network has a reachable address to put in
		// the payload even with no relay configured, so "Add device" is not
		// disabled outright.
		return options.getLanListenerUrl?.() != null;
	});

	return () => {
		unsubscribeSession();
		void closeActive();
		ipcMain.removeHandler("pairing:start-add-device");
		ipcMain.removeHandler("pairing:scan-payload");
		ipcMain.removeHandler("pairing:confirm-sas");
		ipcMain.removeHandler("pairing:cancel");
		ipcMain.removeHandler("pairing:list-devices");
		ipcMain.removeHandler("pairing:revoke-device");
		ipcMain.removeHandler("pairing:this-device");
		ipcMain.removeHandler("pairing:has-relay");
	};
}

function invalid(message: string): Error {
	const err = new Error(message);
	err.name = "Invalid";
	return err;
}

function unavailable(message: string): Error {
	const err = new Error(message);
	err.name = "Unavailable";
	return err;
}

function wrapError(error: unknown): Error {
	if (error instanceof Error) return error;
	return new Error(String(error));
}
