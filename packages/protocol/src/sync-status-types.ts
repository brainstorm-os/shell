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
};

export { AttachmentSyncPauseReason };
