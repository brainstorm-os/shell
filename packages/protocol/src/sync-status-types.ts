/**
 * Renderer-safe IPC-boundary types for Stage 10.7 sync-status.
 *
 * Both `preload/index.ts` and renderer code (`dashboard/use-sync-status.ts`
 * etc.) import from here, so the renderer's value-import of `SyncState` /
 * `SyncTransportState` does NOT drag preload's `import { contextBridge,
 * ipcRenderer } from "electron"` into the renderer bundle (the canonical
 * trap warned about in CLAUDE.md).
 *
 * Main-process internals keep their own `WebSocketRelayState` etc.; this
 * module is the wire-shape only.
 */

import { AttachmentSyncPauseReason } from "./quota-types";

export enum SyncState {
	LocalOnly = "local-only",
	Syncing = "syncing",
	Stale = "stale",
	Offline = "offline",
	Error = "error",
}

export enum SyncTransportState {
	Idle = "idle",
	Connecting = "connecting",
	Open = "open",
	Reconnecting = "reconnecting",
	Closed = "closed",
	Error = "error",
	/** P2P-1 — the socket is up but the peer stopped answering heartbeats. Not
	 *  closed: a frozen peer's socket was measured still usable after it woke,
	 *  so the port degrades and the fallback is armed instead. */
	Degraded = "degraded",
}

/** P2P-1 — which transport is carrying sync. Mirrors main's `ActiveRelayKind`,
 *  and it is why the surface can say "on your local network, no server"
 *  honestly: on LAN there is no third party at all, not even a blind one. The
 *  field has always been on the wire; the renderer type simply did not declare
 *  it, so every consumer was blind to it. */
export enum SyncTransportKind {
	Loopback = "loopback",
	WebSocket = "websocket",
	Lan = "lan",
}

/**
 * P2P-1 — whether this device ACCEPTS LAN connections. Declared here rather
 * than in main so the Settings control and the main-process policy share one
 * declaration instead of two string tables that can drift; `main/sync/
 * lan-host-policy.ts` re-exports it and owns the predicate.
 */
export enum LanHostMode {
	/** Never listen. The default. */
	Off = "off",
	/** Listen whenever a vault is open. */
	WhenVaultOpen = "when-vault-open",
	/** Listen only while a shared entity is open. */
	WhenShared = "when-shared",
}

/**
 * P2P-1 — whether this device DIALS LAN peers. The half that was missing: the
 * host mode above is only "accept", and nothing outside tests ever selected
 * the LAN trust model on the client side, so a device could listen and no
 * device would ever call.
 */
export enum LanDialMode {
	/** Never dial. Sync uses the relay, or stays local-only. The default. */
	Off = "off",
	/** Dial peers found by mDNS discovery, and peers learned from pairing. */
	Auto = "auto",
	/** Dial only the address the user typed, for networks that filter
	 *  multicast. */
	Manual = "manual",
}

export type SyncStatusSnapshot = {
	state: SyncState;
	transportState: SyncTransportState | null;
	relayUrl: string | null;
	connectionId: string | null;
	lastInboundAtMs: number | null;
	lastOutboundAtMs: number | null;
	droppedSends: number;
	droppedInbound: number;
	seqStateBytes: number;
	pairKeyCount: number;
	/** 14.7 — why attachment uploads are paused (storage quota), or null. */
	attachmentSyncPausedReason: AttachmentSyncPauseReason | null;
	/** P2P-1 — LAN vs relay vs local-only. See {@link SyncTransportKind}. */
	transportKind: SyncTransportKind;
};

export { AttachmentSyncPauseReason };
