/**
 * Stage 10.7 — `SyncStatusStore` unit tests.
 *
 * Covers each `SyncState` derived from transport state × traffic recency,
 * the 500ms coalesce window on traffic ticks, the 1-second Error-sticky
 * linger threshold (OQ-209), debounce-bypass on transport-state edges +
 * vault-session changes, counter pass-through, dispose idempotency, and
 * the seq-diagnostic privacy contract (no raw pair keys leak).
 */

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { AttachmentSyncPauseReason } from "../../shared/quota-types";
import {
	ActiveRelayKind,
	type ActiveRelayOrchestrator,
	type ActiveRelayState,
} from "./active-relay";
import { LoopbackRelayPort, type RelayPort } from "./relay-port";
import {
	ERROR_STICKY_MS,
	RECENT_TRAFFIC_MS,
	STALE_AFTER_MS,
	SyncState,
	SyncStatusStore,
	type SyncStatusStoreOptions,
} from "./sync-status-store";
import { WebSocketRelayState } from "./websocket-relay-port";

class FakeWebSocketPort {
	url: string;
	#state: WebSocketRelayState = WebSocketRelayState.Connecting;
	#droppedSends = 0;
	#droppedInbound = 0;
	constructor(url = "wss://relay.example.test/path") {
		this.url = url;
	}
	get state(): WebSocketRelayState {
		return this.#state;
	}
	setState(next: WebSocketRelayState): void {
		this.#state = next;
	}
	droppedSends(): number {
		return this.#droppedSends;
	}
	droppedInbound(): number {
		return this.#droppedInbound;
	}
	bumpDroppedSends(n: number): void {
		this.#droppedSends += n;
	}
	bumpDroppedInbound(n: number): void {
		this.#droppedInbound += n;
	}
	send(_frame: Uint8Array): void {}
	onFrame(_cb: (frame: Uint8Array) => void): void {}
	offFrame(_cb: (frame: Uint8Array) => void): void {}
	close(): void {}
}

class FakeOrchestrator extends EventEmitter {
	#current: ActiveRelayState;
	constructor(initial: ActiveRelayState) {
		super();
		this.#current = initial;
	}
	state(): ActiveRelayState {
		return this.#current;
	}
	setState(next: ActiveRelayState): void {
		this.#current = next;
		this.emit("state", this.#current);
	}
}

function loopbackState(): ActiveRelayState {
	const [port] = LoopbackRelayPort.pair(1);
	if (!port) throw new Error("loopback pair");
	return { kind: ActiveRelayKind.Loopback, port };
}

function wsState(port: FakeWebSocketPort = new FakeWebSocketPort()): ActiveRelayState {
	return {
		kind: ActiveRelayKind.WebSocket,
		port: port as unknown as RelayPort,
		syncRelayUrl: port.url,
	};
}

function makeStore(
	orchestrator: FakeOrchestrator,
	options: {
		clock?: () => number;
		vaultPath?: string | null;
		pairCount?: number;
		size?: number;
		pausedReason?: () => AttachmentSyncPauseReason | null;
	} = {},
) {
	const session = options.vaultPath ? { vaultPath: options.vaultPath } : null;
	const ctor: SyncStatusStoreOptions = {
		activeRelay: orchestrator as unknown as ActiveRelayOrchestrator,
		getVaultSession: () => session,
		statFile: () => ({ size: options.size ?? 0 }),
		readSeqPairCount: () => options.pairCount ?? 0,
	};
	if (options.clock) ctor.clock = options.clock;
	if (options.pausedReason) ctor.getAttachmentSyncPausedReason = options.pausedReason;
	return new SyncStatusStore(ctor);
}

describe("SyncStatusStore", () => {
	it("returns null snapshot without a vault session", () => {
		const orch = new FakeOrchestrator(loopbackState());
		const store = makeStore(orch, { vaultPath: null });
		expect(store.snapshot()).toBeNull();
		store.dispose();
	});

	it("LocalOnly when transport is Loopback", () => {
		const orch = new FakeOrchestrator(loopbackState());
		const store = makeStore(orch, { vaultPath: "/tmp/v1" });
		store.start();
		const snap = store.snapshot();
		expect(snap?.state).toBe(SyncState.LocalOnly);
		expect(snap?.transportState).toBeNull();
		expect(snap?.relayUrl).toBeNull();
		expect(snap?.droppedSends).toBe(0);
		store.dispose();
	});

	it("Offline when transport is Connecting / Reconnecting / Closed", () => {
		const port = new FakeWebSocketPort();
		const orch = new FakeOrchestrator(wsState(port));
		const store = makeStore(orch, { vaultPath: "/tmp/v1" });
		store.start();
		for (const state of [
			WebSocketRelayState.Connecting,
			WebSocketRelayState.Reconnecting,
			WebSocketRelayState.Closed,
			WebSocketRelayState.Idle,
		]) {
			port.setState(state);
			orch.setState(wsState(port));
			expect(store.snapshot()?.state).toBe(SyncState.Offline);
		}
		store.dispose();
	});

	it("Syncing when transport Open AND recent traffic", () => {
		const port = new FakeWebSocketPort();
		port.setState(WebSocketRelayState.Open);
		const orch = new FakeOrchestrator(wsState(port));
		let now = 1_000_000;
		const store = makeStore(orch, { vaultPath: "/tmp/v1", clock: () => now });
		store.start();
		store.recordInbound(123);
		now += 1000;
		expect(store.snapshot()?.state).toBe(SyncState.Syncing);
		store.dispose();
	});

	it("Stale when transport Open AND no traffic for STALE_AFTER_MS", () => {
		const port = new FakeWebSocketPort();
		port.setState(WebSocketRelayState.Open);
		const orch = new FakeOrchestrator(wsState(port));
		let now = 1_000_000;
		const store = makeStore(orch, { vaultPath: "/tmp/v1", clock: () => now });
		store.start();
		store.recordInbound(123);
		now += STALE_AFTER_MS + 1;
		expect(store.snapshot()?.state).toBe(SyncState.Stale);
		store.dispose();
	});

	it("Stale when transport Open AND traffic never observed", () => {
		const port = new FakeWebSocketPort();
		port.setState(WebSocketRelayState.Open);
		const orch = new FakeOrchestrator(wsState(port));
		const store = makeStore(orch, { vaultPath: "/tmp/v1" });
		store.start();
		expect(store.snapshot()?.state).toBe(SyncState.Stale);
		store.dispose();
	});

	it("Error transient (<1s) folds into Offline; sticky (>=1s) paints Error", async () => {
		vi.useFakeTimers();
		try {
			const port = new FakeWebSocketPort();
			const orch = new FakeOrchestrator(wsState(port));
			let now = 1_000_000;
			const store = makeStore(orch, { vaultPath: "/tmp/v1", clock: () => now });
			store.start();
			port.setState(WebSocketRelayState.Error);
			orch.setState(wsState(port));
			// Inside the linger window — folds into Offline.
			expect(store.snapshot()?.state).toBe(SyncState.Offline);
			now += ERROR_STICKY_MS + 1;
			await vi.advanceTimersByTimeAsync(ERROR_STICKY_MS + 5);
			expect(store.snapshot()?.state).toBe(SyncState.Error);
			store.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("traffic ticks coalesce on a 500ms trailing timer", async () => {
		vi.useFakeTimers();
		try {
			const port = new FakeWebSocketPort();
			port.setState(WebSocketRelayState.Open);
			const orch = new FakeOrchestrator(wsState(port));
			const store = makeStore(orch, { vaultPath: "/tmp/v1" });
			store.start();
			const listener = vi.fn();
			store.onChange(listener);
			store.recordInbound(10);
			store.recordInbound(20);
			store.recordInbound(30);
			expect(listener).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(500);
			expect(listener).toHaveBeenCalledTimes(1);
			store.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("transport-state edges fire immediately (bypass debounce)", () => {
		const port = new FakeWebSocketPort();
		port.setState(WebSocketRelayState.Connecting);
		const orch = new FakeOrchestrator(wsState(port));
		const store = makeStore(orch, { vaultPath: "/tmp/v1" });
		store.start();
		const listener = vi.fn();
		store.onChange(listener);
		port.setState(WebSocketRelayState.Open);
		orch.setState(wsState(port));
		expect(listener).toHaveBeenCalled();
		store.dispose();
	});

	it("vault-session-changed bypasses debounce + resets traffic counters", () => {
		const orch = new FakeOrchestrator(loopbackState());
		const store = makeStore(orch, { vaultPath: "/tmp/v1" });
		store.start();
		store.recordInbound(99);
		const listener = vi.fn();
		store.onChange(listener);
		store.notifyVaultSessionChanged();
		expect(listener).toHaveBeenCalled();
		const snap = store.snapshot();
		expect(snap?.lastInboundAtMs).toBeNull();
		store.dispose();
	});

	it("dropped-sends + dropped-inbound flow through from the transport", () => {
		const port = new FakeWebSocketPort();
		port.setState(WebSocketRelayState.Open);
		port.bumpDroppedSends(7);
		port.bumpDroppedInbound(3);
		const orch = new FakeOrchestrator(wsState(port));
		const store = makeStore(orch, { vaultPath: "/tmp/v1" });
		store.start();
		const snap = store.snapshot();
		expect(snap?.droppedSends).toBe(7);
		expect(snap?.droppedInbound).toBe(3);
		store.dispose();
	});

	it("seq diagnostic exposes count + bytes only, no raw pair keys", () => {
		const port = new FakeWebSocketPort();
		port.setState(WebSocketRelayState.Open);
		const orch = new FakeOrchestrator(wsState(port));
		const store = makeStore(orch, {
			vaultPath: "/tmp/v1",
			pairCount: 5,
			size: 1234,
		});
		store.start();
		const snap = store.snapshot();
		expect(snap?.pairKeyCount).toBe(5);
		expect(snap?.seqStateBytes).toBe(1234);
		// Negative pin: snapshot shape carries only count + bytes; no
		// `pairs` field, no `senders` field, nothing pubkey-shaped.
		const exposed = Object.keys(snap ?? {});
		expect(exposed).not.toContain("pairs");
		expect(exposed).not.toContain("senders");
		expect(exposed).not.toContain("pairKeys");
		store.dispose();
	});

	it("dispose cancels pending coalesce + clears listeners", async () => {
		vi.useFakeTimers();
		try {
			const port = new FakeWebSocketPort();
			port.setState(WebSocketRelayState.Open);
			const orch = new FakeOrchestrator(wsState(port));
			const store = makeStore(orch, { vaultPath: "/tmp/v1" });
			store.start();
			const listener = vi.fn();
			store.onChange(listener);
			store.recordInbound(1);
			store.dispose();
			await vi.advanceTimersByTimeAsync(500);
			expect(listener).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("dispose is idempotent", () => {
		const orch = new FakeOrchestrator(loopbackState());
		const store = makeStore(orch, { vaultPath: "/tmp/v1" });
		store.start();
		store.dispose();
		expect(() => store.dispose()).not.toThrow();
	});

	it("snapshot stays the same shape across all states", () => {
		const port = new FakeWebSocketPort();
		port.setState(WebSocketRelayState.Open);
		const orch = new FakeOrchestrator(wsState(port));
		const store = makeStore(orch, { vaultPath: "/tmp/v1" });
		store.start();
		const snap = store.snapshot();
		const expectedKeys = [
			"state",
			"transportState",
			"relayUrl",
			"connectionId",
			"lastInboundAtMs",
			"lastOutboundAtMs",
			"droppedSends",
			"droppedInbound",
			"seqStateBytes",
			"pairKeyCount",
			"attachmentSyncPausedReason",
		].sort();
		expect(Object.keys(snap ?? {}).sort()).toEqual(expectedKeys);
		store.dispose();
	});

	it("relayUrl is null on LocalOnly + populated on WebSocket", () => {
		const orch = new FakeOrchestrator(loopbackState());
		const store = makeStore(orch, { vaultPath: "/tmp/v1" });
		store.start();
		expect(store.snapshot()?.relayUrl).toBeNull();
		const port = new FakeWebSocketPort("wss://r.test:443/ws");
		port.setState(WebSocketRelayState.Open);
		orch.setState(wsState(port));
		expect(store.snapshot()?.relayUrl).toBe("wss://r.test:443/ws");
		store.dispose();
	});

	it("multiple listeners all receive change events", async () => {
		vi.useFakeTimers();
		try {
			const port = new FakeWebSocketPort();
			port.setState(WebSocketRelayState.Open);
			const orch = new FakeOrchestrator(wsState(port));
			const store = makeStore(orch, { vaultPath: "/tmp/v1" });
			store.start();
			const a = vi.fn();
			const b = vi.fn();
			store.onChange(a);
			store.onChange(b);
			store.recordInbound(1);
			await vi.advanceTimersByTimeAsync(500);
			expect(a).toHaveBeenCalled();
			expect(b).toHaveBeenCalled();
			store.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("snapshot carries the quota pause reason from the injected signal (14.7)", () => {
		let reason: AttachmentSyncPauseReason | null = null;
		const orch = new FakeOrchestrator(loopbackState());
		const store = makeStore(orch, { vaultPath: "/tmp/v1", pausedReason: () => reason });
		store.start();
		expect(store.snapshot()?.attachmentSyncPausedReason).toBe(null);
		reason = AttachmentSyncPauseReason.StorageQuota;
		expect(store.snapshot()?.attachmentSyncPausedReason).toBe(AttachmentSyncPauseReason.StorageQuota);
		store.dispose();
	});

	it("defaults the pause reason to null (no signal injected) and survives a throwing one", () => {
		const orch = new FakeOrchestrator(loopbackState());
		const store = makeStore(orch, { vaultPath: "/tmp/v1" });
		expect(store.snapshot()?.attachmentSyncPausedReason).toBe(null);
		store.dispose();
		const throwing = makeStore(orch, {
			vaultPath: "/tmp/v1",
			pausedReason: () => {
				throw new Error("quota service gone");
			},
		});
		expect(throwing.snapshot()?.attachmentSyncPausedReason).toBe(null);
		throwing.dispose();
	});

	it("notifyQuotaChanged re-emits immediately, bypassing the coalesce debounce (14.7)", () => {
		const orch = new FakeOrchestrator(loopbackState());
		const store = makeStore(orch, { vaultPath: "/tmp/v1" });
		store.start();
		const seen: unknown[] = [];
		store.onChange((snap) => seen.push(snap));
		store.notifyQuotaChanged();
		expect(seen).toHaveLength(1);
		store.dispose();
		store.notifyQuotaChanged(); // disposed — must not throw or emit
		expect(seen).toHaveLength(1);
	});

	it("RECENT_TRAFFIC_MS / STALE_AFTER_MS constants match OQ-208", () => {
		expect(RECENT_TRAFFIC_MS).toBe(5_000);
		expect(STALE_AFTER_MS).toBe(30_000);
	});
});
