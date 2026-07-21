/**
 * Stage 10.7 — sync-status renderer hook.
 *
 * Subscribes to the privileged `window.brainstorm.syncStatus` push stream;
 * returns null until the first snapshot arrives. Runs ONE shared 5-second
 * `setInterval` to re-derive `SyncState.Stale` against `Date.now()` so
 * `Syncing → Stale` flips without main re-pushing on a quiet wire (the
 * main store wakes on traffic ticks + transport-state edges only — stale
 * is a pure age computation).
 *
 * The hook is renderer-cheap: one IPC channel subscription + one timer
 * for the whole dashboard. Components consume `derivedState` instead of
 * `snapshot.state` so the renderer-side stale override actually applies.
 */

import {
	SyncState,
	type SyncStatusSnapshot,
	SyncTransportState,
} from "@brainstorm-os/protocol/sync-status-types";
import { useEffect, useState } from "react";

export { SyncState, SyncTransportState };
export type { SyncStatusSnapshot };

export const RECENT_TRAFFIC_MS = 5_000;
export const STALE_AFTER_MS = 30_000;
const STALE_TICK_MS = 5_000;

export type UseSyncStatusResult = {
	snapshot: SyncStatusSnapshot | null;
	derivedState: SyncState | null;
};

export function deriveSyncState(snap: SyncStatusSnapshot | null, now: number): SyncState | null {
	if (!snap) return null;
	if (snap.state === SyncState.LocalOnly) return SyncState.LocalOnly;
	if (snap.state === SyncState.Error) return SyncState.Error;
	if (snap.transportState !== SyncTransportState.Open) return SyncState.Offline;
	const latest = Math.max(
		snap.lastInboundAtMs ?? Number.NEGATIVE_INFINITY,
		snap.lastOutboundAtMs ?? Number.NEGATIVE_INFINITY,
	);
	if (!Number.isFinite(latest)) return SyncState.Stale;
	const age = now - latest;
	if (age <= RECENT_TRAFFIC_MS) return SyncState.Syncing;
	if (age >= STALE_AFTER_MS) return SyncState.Stale;
	return SyncState.Syncing;
}

export function useSyncStatus(): UseSyncStatusResult {
	const [snapshot, setSnapshot] = useState<SyncStatusSnapshot | null>(null);
	const [now, setNow] = useState<number>(() => Date.now());

	useEffect(() => {
		let cancelled = false;
		const bridge = window.brainstorm?.syncStatus;
		if (!bridge) return;
		void bridge.snapshot().then((snap) => {
			if (!cancelled && snap) setSnapshot(snap);
		});
		const off = bridge.on((snap) => {
			setSnapshot(snap);
		});
		return () => {
			cancelled = true;
			off();
		};
	}, []);

	useEffect(() => {
		const id = setInterval(() => {
			setNow(Date.now());
		}, STALE_TICK_MS);
		return () => clearInterval(id);
	}, []);

	return { snapshot, derivedState: deriveSyncState(snapshot, now) };
}
