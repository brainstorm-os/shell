/**
 * `sync-status:*` IPC handlers — module surface + lifecycle contract.
 *
 * The heavy state-derivation coverage lives in `sync-status-store.test.ts`.
 * These tests pin the channel id, the registration entry point, and the
 * snapshot-push lifecycle (start on register, broadcast on change, skip
 * when the window is destroyed).
 */

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { LanDialMode } from "../sync/lan-dial-coordinator";
import { LanHostMode } from "../sync/lan-host-policy";
import type { SyncStatusSnapshot, SyncStatusStore } from "../sync/sync-status-store";

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, IpcHandler>();
vi.mock("electron", () => ({
	ipcMain: {
		handle: (channel: string, fn: IpcHandler) => {
			handlers.set(channel, fn);
		},
	},
}));

import { SYNC_STATUS_SNAPSHOT_CHANNEL, registerSyncStatusHandlers } from "./sync-status-handlers";

class FakeStore
	extends EventEmitter
	implements
		Pick<
			SyncStatusStore,
			| "start"
			| "stop"
			| "snapshot"
			| "onChange"
			| "dispose"
			| "recordOutbound"
			| "recordInbound"
			| "notifyVaultSessionChanged"
		>
{
	#started = false;
	#snapshot: SyncStatusSnapshot | null = null;
	#listeners = new Set<(snap: SyncStatusSnapshot | null) => void>();
	start(): void {
		this.#started = true;
	}
	stop(): void {
		this.#started = false;
	}
	dispose(): void {}
	recordOutbound(): void {}
	recordInbound(): void {}
	notifyVaultSessionChanged(): void {}
	snapshot(): SyncStatusSnapshot | null {
		return this.#snapshot;
	}
	setSnapshot(snap: SyncStatusSnapshot | null): void {
		this.#snapshot = snap;
	}
	onChange(listener: (snap: SyncStatusSnapshot | null) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}
	emitChange(snap: SyncStatusSnapshot | null): void {
		for (const listener of this.#listeners) listener(snap);
	}
	isStarted(): boolean {
		return this.#started;
	}
}

class FakeBrowserWindow {
	destroyed = false;
	webContents = {
		send: vi.fn(),
	};
	isDestroyed(): boolean {
		return this.destroyed;
	}
}

/** P2P-1 — the dial-half options, which every registration now carries. Inert
 *  stubs: these tests are about registration and the push channel, and the LAN
 *  dial behaviour has its own suites. */
function lanPeeringStubs() {
	const snapshot = {
		dialMode: LanDialMode.Off,
		manualUrl: null,
		activeUrl: null,
		listenerUrl: null,
		peers: [],
	};
	return {
		getLanPeering: async () => snapshot,
		setLanDialMode: async () => snapshot,
		setLanPeerAddress: async () => snapshot,
	};
}

describe("SYNC_STATUS_SNAPSHOT_CHANNEL", () => {
	it("exposes the canonical channel id", () => {
		expect(SYNC_STATUS_SNAPSHOT_CHANNEL).toBe("sync-status:snapshot");
	});
});

describe("registerSyncStatusHandlers", () => {
	it("is callable", () => {
		expect(typeof registerSyncStatusHandlers).toBe("function");
	});

	it("starts the store on register", () => {
		const store = new FakeStore();
		const win = new FakeBrowserWindow();
		registerSyncStatusHandlers({
			getDashboard: () => win as unknown as Electron.BrowserWindow,
			syncStatusStore: store as unknown as SyncStatusStore,
			selectiveSyncStore: {
				load: async () => ({ mode: "everything", recentDays: 30 }),
				set: async (p: unknown) => p,
			} as unknown as import("../sync/selective-sync-store").SelectiveSyncStore,
			onPolicyChanged: () => {},
			isRestoreAvailable: async () => false,
			runRestore: async () => ({ requested: 0, restored: 0, entityIds: [], complete: true }),
			getLanHostMode: async () => LanHostMode.Off,
			setLanHostMode: async () => LanHostMode.Off,
			...lanPeeringStubs(),
		});
		expect(store.isStarted()).toBe(true);
	});

	it("broadcasts onChange events to the dashboard", () => {
		const store = new FakeStore();
		const win = new FakeBrowserWindow();
		registerSyncStatusHandlers({
			getDashboard: () => win as unknown as Electron.BrowserWindow,
			syncStatusStore: store as unknown as SyncStatusStore,
			selectiveSyncStore: {
				load: async () => ({ mode: "everything", recentDays: 30 }),
				set: async (p: unknown) => p,
			} as unknown as import("../sync/selective-sync-store").SelectiveSyncStore,
			onPolicyChanged: () => {},
			isRestoreAvailable: async () => false,
			runRestore: async () => ({ requested: 0, restored: 0, entityIds: [], complete: true }),
			getLanHostMode: async () => LanHostMode.Off,
			setLanHostMode: async () => LanHostMode.Off,
			...lanPeeringStubs(),
		});
		store.emitChange({
			state: "syncing",
			transportState: "open",
			relayUrl: "wss://r.test",
			connectionId: null,
			lastInboundAtMs: null,
			lastOutboundAtMs: null,
			droppedSends: 0,
			droppedInbound: 0,
			seqStateBytes: 0,
			pairKeyCount: 0,
		} as SyncStatusSnapshot);
		expect(win.webContents.send).toHaveBeenCalledWith(
			SYNC_STATUS_SNAPSHOT_CHANNEL,
			expect.any(Object),
		);
	});

	it("skips broadcast when the dashboard window is destroyed", () => {
		const store = new FakeStore();
		const win = new FakeBrowserWindow();
		win.destroyed = true;
		registerSyncStatusHandlers({
			getDashboard: () => win as unknown as Electron.BrowserWindow,
			syncStatusStore: store as unknown as SyncStatusStore,
			selectiveSyncStore: {
				load: async () => ({ mode: "everything", recentDays: 30 }),
				set: async (p: unknown) => p,
			} as unknown as import("../sync/selective-sync-store").SelectiveSyncStore,
			onPolicyChanged: () => {},
			isRestoreAvailable: async () => false,
			runRestore: async () => ({ requested: 0, restored: 0, entityIds: [], complete: true }),
			getLanHostMode: async () => LanHostMode.Off,
			setLanHostMode: async () => LanHostMode.Off,
			...lanPeeringStubs(),
		});
		store.emitChange(null);
		expect(win.webContents.send).not.toHaveBeenCalled();
	});

	it("skips broadcast when the dashboard window is missing", () => {
		const store = new FakeStore();
		registerSyncStatusHandlers({
			getDashboard: () => null,
			syncStatusStore: store as unknown as SyncStatusStore,
			selectiveSyncStore: {
				load: async () => ({ mode: "everything", recentDays: 30 }),
				set: async (p: unknown) => p,
			} as unknown as import("../sync/selective-sync-store").SelectiveSyncStore,
			onPolicyChanged: () => {},
			isRestoreAvailable: async () => false,
			runRestore: async () => ({ requested: 0, restored: 0, entityIds: [], complete: true }),
			getLanHostMode: async () => LanHostMode.Off,
			setLanHostMode: async () => LanHostMode.Off,
			...lanPeeringStubs(),
		});
		store.emitChange(null);
		// No throw + no crash is the contract here.
		expect(true).toBe(true);
	});

	it("re-binding swaps the change listener (no double-push)", () => {
		const store = new FakeStore();
		const winA = new FakeBrowserWindow();
		const winB = new FakeBrowserWindow();
		registerSyncStatusHandlers({
			getDashboard: () => winA as unknown as Electron.BrowserWindow,
			syncStatusStore: store as unknown as SyncStatusStore,
			selectiveSyncStore: {
				load: async () => ({ mode: "everything", recentDays: 30 }),
				set: async (p: unknown) => p,
			} as unknown as import("../sync/selective-sync-store").SelectiveSyncStore,
			onPolicyChanged: () => {},
			isRestoreAvailable: async () => false,
			runRestore: async () => ({ requested: 0, restored: 0, entityIds: [], complete: true }),
			getLanHostMode: async () => LanHostMode.Off,
			setLanHostMode: async () => LanHostMode.Off,
			...lanPeeringStubs(),
		});
		registerSyncStatusHandlers({
			getDashboard: () => winB as unknown as Electron.BrowserWindow,
			syncStatusStore: store as unknown as SyncStatusStore,
			selectiveSyncStore: {
				load: async () => ({ mode: "everything", recentDays: 30 }),
				set: async (p: unknown) => p,
			} as unknown as import("../sync/selective-sync-store").SelectiveSyncStore,
			onPolicyChanged: () => {},
			isRestoreAvailable: async () => false,
			runRestore: async () => ({ requested: 0, restored: 0, entityIds: [], complete: true }),
			getLanHostMode: async () => LanHostMode.Off,
			setLanHostMode: async () => LanHostMode.Off,
			...lanPeeringStubs(),
		});
		store.emitChange(null);
		// Only winB receives the push — the prior subscription was disposed.
		expect(winA.webContents.send).not.toHaveBeenCalled();
		expect(winB.webContents.send).toHaveBeenCalledTimes(1);
	});

	it("subscribed listener swallows handler throws without crashing main", () => {
		const store = new FakeStore();
		const win = new FakeBrowserWindow();
		win.webContents.send.mockImplementation(() => {
			throw new Error("send failed");
		});
		registerSyncStatusHandlers({
			getDashboard: () => win as unknown as Electron.BrowserWindow,
			syncStatusStore: store as unknown as SyncStatusStore,
			selectiveSyncStore: {
				load: async () => ({ mode: "everything", recentDays: 30 }),
				set: async (p: unknown) => p,
			} as unknown as import("../sync/selective-sync-store").SelectiveSyncStore,
			onPolicyChanged: () => {},
			isRestoreAvailable: async () => false,
			runRestore: async () => ({ requested: 0, restored: 0, entityIds: [], complete: true }),
			getLanHostMode: async () => LanHostMode.Off,
			setLanHostMode: async () => LanHostMode.Off,
			...lanPeeringStubs(),
		});
		expect(() => store.emitChange(null)).not.toThrow();
	});

	it("repeated registration starts the store again (idempotent)", () => {
		const store = new FakeStore();
		const win = new FakeBrowserWindow();
		registerSyncStatusHandlers({
			getDashboard: () => win as unknown as Electron.BrowserWindow,
			syncStatusStore: store as unknown as SyncStatusStore,
			selectiveSyncStore: {
				load: async () => ({ mode: "everything", recentDays: 30 }),
				set: async (p: unknown) => p,
			} as unknown as import("../sync/selective-sync-store").SelectiveSyncStore,
			onPolicyChanged: () => {},
			isRestoreAvailable: async () => false,
			runRestore: async () => ({ requested: 0, restored: 0, entityIds: [], complete: true }),
			getLanHostMode: async () => LanHostMode.Off,
			setLanHostMode: async () => LanHostMode.Off,
			...lanPeeringStubs(),
		});
		store.stop();
		registerSyncStatusHandlers({
			getDashboard: () => win as unknown as Electron.BrowserWindow,
			syncStatusStore: store as unknown as SyncStatusStore,
			selectiveSyncStore: {
				load: async () => ({ mode: "everything", recentDays: 30 }),
				set: async (p: unknown) => p,
			} as unknown as import("../sync/selective-sync-store").SelectiveSyncStore,
			onPolicyChanged: () => {},
			isRestoreAvailable: async () => false,
			runRestore: async () => ({ requested: 0, restored: 0, entityIds: [], complete: true }),
			getLanHostMode: async () => LanHostMode.Off,
			setLanHostMode: async () => LanHostMode.Off,
			...lanPeeringStubs(),
		});
		expect(store.isStarted()).toBe(true);
	});

	it("set-policy persists via the store + fires onPolicyChanged (10.13)", async () => {
		const store = new FakeStore();
		const win = new FakeBrowserWindow();
		const setCalls: unknown[] = [];
		let policyChanged = 0;
		registerSyncStatusHandlers({
			getDashboard: () => win as unknown as Electron.BrowserWindow,
			syncStatusStore: store as unknown as SyncStatusStore,
			selectiveSyncStore: {
				load: async () => ({ mode: "everything", recentDays: 30 }),
				set: async (p: unknown) => {
					setCalls.push(p);
					return { mode: "pinned", recentDays: 7 };
				},
			} as unknown as import("../sync/selective-sync-store").SelectiveSyncStore,
			onPolicyChanged: () => {
				policyChanged += 1;
			},
			isRestoreAvailable: async () => false,
			runRestore: async () => ({ requested: 0, restored: 0, entityIds: [], complete: true }),
			getLanHostMode: async () => LanHostMode.Off,
			setLanHostMode: async () => LanHostMode.Off,
			...lanPeeringStubs(),
		});
		const setHandler = handlers.get("sync-status:set-policy");
		expect(setHandler).toBeTypeOf("function");
		const result = await setHandler?.({}, { mode: "pinned", recentDays: 7 });
		expect(setCalls).toEqual([{ mode: "pinned", recentDays: 7 }]);
		expect(policyChanged).toBe(1);
		expect(result).toEqual({ mode: "pinned", recentDays: 7 });

		const getHandler = handlers.get("sync-status:get-policy");
		expect(await getHandler?.({})).toEqual({ mode: "everything", recentDays: 30 });
	});
});
