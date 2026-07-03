/**
 * `useSyncStatus()` hook — pure derivation helper tests +
 * `deriveSyncState` unit tests covering every transport-state ×
 * traffic-age combination renderer-side stale derivation needs.
 */

import { describe, expect, it } from "vitest";
import { SyncTransportState } from "../../preload";
import {
	RECENT_TRAFFIC_MS,
	STALE_AFTER_MS,
	SyncState,
	type SyncStatusSnapshot,
	deriveSyncState,
} from "./use-sync-status";

function snap(partial: Partial<SyncStatusSnapshot> = {}): SyncStatusSnapshot {
	return {
		state: SyncState.Syncing,
		transportState: SyncTransportState.Open,
		relayUrl: null,
		connectionId: null,
		lastInboundAtMs: null,
		lastOutboundAtMs: null,
		droppedSends: 0,
		droppedInbound: 0,
		seqStateBytes: 0,
		pairKeyCount: 0,
		attachmentSyncPausedReason: null,
		...partial,
	};
}

describe("deriveSyncState", () => {
	it("null snapshot returns null", () => {
		expect(deriveSyncState(null, 1_000)).toBeNull();
	});

	it("LocalOnly mirrors through", () => {
		expect(deriveSyncState(snap({ state: SyncState.LocalOnly }), 1_000)).toBe(SyncState.LocalOnly);
	});

	it("Error mirrors through (1s sticky decided main-side)", () => {
		expect(deriveSyncState(snap({ state: SyncState.Error }), 1_000)).toBe(SyncState.Error);
	});

	it("transport not Open ⇒ Offline", () => {
		for (const ts of [
			SyncTransportState.Connecting,
			SyncTransportState.Reconnecting,
			SyncTransportState.Closed,
			SyncTransportState.Idle,
		]) {
			expect(deriveSyncState(snap({ transportState: ts }), 1_000)).toBe(SyncState.Offline);
		}
	});

	it("transport Open + recent traffic ⇒ Syncing", () => {
		const now = 1_000_000;
		expect(deriveSyncState(snap({ lastInboundAtMs: now - 1_000 }), now)).toBe(SyncState.Syncing);
	});

	it("transport Open + no traffic for >= STALE_AFTER_MS ⇒ Stale", () => {
		const now = 1_000_000;
		expect(deriveSyncState(snap({ lastInboundAtMs: now - STALE_AFTER_MS - 1 }), now)).toBe(
			SyncState.Stale,
		);
	});

	it("transport Open + traffic never observed ⇒ Stale", () => {
		expect(deriveSyncState(snap({}), 1_000)).toBe(SyncState.Stale);
	});

	it("between RECENT_TRAFFIC_MS and STALE_AFTER_MS ⇒ Syncing (mid-flight)", () => {
		const now = 1_000_000;
		expect(deriveSyncState(snap({ lastInboundAtMs: now - (RECENT_TRAFFIC_MS + 1000) }), now)).toBe(
			SyncState.Syncing,
		);
	});

	it("outbound or inbound ticks both count toward recency", () => {
		const now = 1_000_000;
		expect(deriveSyncState(snap({ lastOutboundAtMs: now - 100 }), now)).toBe(SyncState.Syncing);
		expect(deriveSyncState(snap({ lastInboundAtMs: now - 100 }), now)).toBe(SyncState.Syncing);
	});

	it("constants match OQ-208", () => {
		expect(RECENT_TRAFFIC_MS).toBe(5_000);
		expect(STALE_AFTER_MS).toBe(30_000);
	});
});
