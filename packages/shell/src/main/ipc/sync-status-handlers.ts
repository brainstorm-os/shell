/**
 * `sync-status:*` IPC handlers — Stage 10.7. Dashboard-only privileged
 * surface (mirrors the `pairing:*` / `files-handles:*` pattern). One
 * accessor channel (`sync-status:snapshot`, query) + one push channel
 * (`sync-status:snapshot`, main→renderer broadcast). Lifecycle: started
 * when a vault session opens, stopped on session-clear.
 *
 * Apps don't read this surface — OQ-206 deferred app-side `sync.status:read`
 * cap to v2. Only the dashboard reads/binds.
 */

import type { SelectiveSyncPolicy } from "@brainstorm-os/protocol/selective-sync-types";
import type { BrowserWindow } from "electron";
import { ipcMain } from "electron";
import type { LanHostMode } from "../sync/lan-host-policy";
import type { RestoreSummary } from "../sync/restore-engine";
import type { SelectiveSyncStore } from "../sync/selective-sync-store";
import type { SyncStatusSnapshot, SyncStatusStore } from "../sync/sync-status-store";

export const SYNC_STATUS_SNAPSHOT_CHANNEL = "sync-status:snapshot";
/** Stage 10.13 — dashboard reads/writes the per-device selective-sync policy. */
export const SYNC_POLICY_GET_CHANNEL = "sync-status:get-policy";
export const SYNC_POLICY_SET_CHANNEL = "sync-status:set-policy";
/** Stage 10.14 — dashboard offers + drives cold restore-from-zero. */
/** LAN-4c — dashboard reads/writes the device's LAN host-listen mode. */
export const SYNC_LAN_HOST_GET_CHANNEL = "sync-status:get-lan-host-mode";
export const SYNC_LAN_HOST_SET_CHANNEL = "sync-status:set-lan-host-mode";
/** P2P-1 — the DIAL half of LAN sync, which had no user-reachable surface at
 *  all: the toggle above controls only whether this device ACCEPTS
 *  connections. These are what let a user turn on going and finding the other
 *  machine. */
export const SYNC_LAN_PEERING_GET_CHANNEL = "sync-status:get-lan-peering";
export const SYNC_LAN_DIAL_MODE_SET_CHANNEL = "sync-status:set-lan-dial-mode";
export const SYNC_LAN_PEER_ADDRESS_SET_CHANNEL = "sync-status:set-lan-peer-address";
export const SYNC_RESTORE_AVAILABLE_CHANNEL = "sync-status:restore-available";
export const SYNC_RESTORE_CHANNEL = "sync-status:restore";

export type SyncStatusHandlersOptions = {
	getDashboard: () => BrowserWindow | null;
	syncStatusStore: SyncStatusStore;
	/** 10.13 — the per-device selective-sync policy store. */
	selectiveSyncStore: SelectiveSyncStore;
	/** 10.13 — invoked after the policy changes so the live-sync engine can
	 *  re-evaluate which tracked entities still sync. */
	onPolicyChanged: () => void;
	/** 10.14 — whether a cold restore is offerable: a keystore-intact device
	 *  with an empty `entities.db` and a reachable durable node. */
	isRestoreAvailable: () => Promise<boolean>;
	/** 10.14 — run a restore-from-zero pass against the durable node. Rejects
	 *  if no session / no durable node is active. */
	runRestore: () => Promise<RestoreSummary>;
	/** LAN-4c — read the device's LAN host-listen mode. */
	getLanHostMode: () => Promise<LanHostMode>;
	/** LAN-4c — persist the mode and re-apply the listener policy. Returns the
	 *  mode actually stored (an unrecognised value normalises to `Off`). */
	setLanHostMode: (mode: unknown) => Promise<LanHostMode>;
	/** P2P-1 — everything the Settings LAN group renders in one read, so the
	 *  panel cannot show a dial mode from one moment and a peer list from
	 *  another. */
	getLanPeering: () => Promise<LanPeeringSnapshot>;
	/** P2P-1 — persist the dial mode and re-select a target. Returns the mode
	 *  actually stored (anything unrecognised normalises to `Off`). */
	setLanDialMode: (mode: unknown) => Promise<LanPeeringSnapshot>;
	/** P2P-1 — set (or clear with `null`) the manual peer address. Returns
	 *  `null` when the address does not validate, so the panel can say so
	 *  rather than silently never dialling. */
	setLanPeerAddress: (raw: unknown) => Promise<LanPeeringSnapshot | null>;
};

/** P2P-1 — what Settings → Sync needs to render the local-network group. */
export type LanPeeringSnapshot = {
	/** `off` | `auto` | `manual`. A plain string across IPC; main normalises. */
	dialMode: string;
	/** The stored manual address, or `null`. */
	manualUrl: string | null;
	/** The peer this device is currently dialling, or `null` for "using the
	 *  relay". */
	activeUrl: string | null;
	/** This device's own listener URL when hosting — what the OTHER machine
	 *  types in, and what a pairing payload now carries. */
	listenerUrl: string | null;
	/** Verified peers seen on the network, freshest first. Every entry proved a
	 *  valid rotating discovery tag, so these are this identity's own devices. */
	peers: readonly { instance: string; urls: readonly string[] }[];
};

let unsubscribe: (() => void) | null = null;
let registered = false;
// The `ipcMain.handle` callbacks register once, but the dependencies they read
// (the stores, the dashboard getter, the policy-change hook) are rebound on
// every `registerSyncStatusHandlers` call so a session swap is transparent —
// the handlers read from this latest-options ref, never a stale capture.
let active: SyncStatusHandlersOptions | null = null;

export function registerSyncStatusHandlers(options: SyncStatusHandlersOptions): void {
	active = options;

	if (!registered) {
		ipcMain.handle(
			SYNC_STATUS_SNAPSHOT_CHANNEL,
			async (): Promise<SyncStatusSnapshot | null> => active?.syncStatusStore.snapshot() ?? null,
		);
		ipcMain.handle(
			SYNC_POLICY_GET_CHANNEL,
			async (): Promise<SelectiveSyncPolicy | null> =>
				active ? active.selectiveSyncStore.load() : null,
		);
		ipcMain.handle(
			SYNC_POLICY_SET_CHANNEL,
			async (_event, policy: unknown): Promise<SelectiveSyncPolicy | null> => {
				if (!active) return null;
				const next = await active.selectiveSyncStore.set(policy);
				try {
					active.onPolicyChanged();
				} catch (error) {
					console.warn("[brainstorm] selective-sync onPolicyChanged failed:", error);
				}
				return next;
			},
		);
		ipcMain.handle(
			SYNC_LAN_HOST_GET_CHANNEL,
			async (): Promise<LanHostMode | null> => (active ? active.getLanHostMode() : null),
		);
		ipcMain.handle(
			SYNC_LAN_HOST_SET_CHANNEL,
			async (_event, mode: unknown): Promise<LanHostMode | null> =>
				active ? active.setLanHostMode(mode) : null,
		);
		ipcMain.handle(
			SYNC_LAN_PEERING_GET_CHANNEL,
			async (): Promise<LanPeeringSnapshot | null> => (active ? active.getLanPeering() : null),
		);
		ipcMain.handle(
			SYNC_LAN_DIAL_MODE_SET_CHANNEL,
			async (_event, mode: unknown): Promise<LanPeeringSnapshot | null> =>
				active ? active.setLanDialMode(mode) : null,
		);
		ipcMain.handle(
			SYNC_LAN_PEER_ADDRESS_SET_CHANNEL,
			async (_event, raw: unknown): Promise<LanPeeringSnapshot | null> =>
				active ? active.setLanPeerAddress(raw) : null,
		);
		ipcMain.handle(
			SYNC_RESTORE_AVAILABLE_CHANNEL,
			async (): Promise<boolean> => (active ? active.isRestoreAvailable() : false),
		);
		ipcMain.handle(SYNC_RESTORE_CHANNEL, async (): Promise<RestoreSummary> => {
			if (!active) throw new Error("sync: no active session");
			return active.runRestore();
		});
		registered = true;
	}

	if (unsubscribe) unsubscribe();
	unsubscribe = options.syncStatusStore.onChange((snap) => {
		const target = active?.getDashboard() ?? null;
		if (!target || target.isDestroyed()) return;
		try {
			target.webContents.send(SYNC_STATUS_SNAPSHOT_CHANNEL, snap);
		} catch (error) {
			console.warn("[brainstorm] sync-status push failed:", error);
		}
	});

	options.syncStatusStore.start();
}

export function disposeSyncStatusHandlers(): void {
	if (unsubscribe) {
		unsubscribe();
		unsubscribe = null;
	}
}
