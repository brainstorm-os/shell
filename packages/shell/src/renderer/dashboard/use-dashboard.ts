/**
 * Subscribes to the shell-owned dashboard snapshot stream. The main process
 * loads the doc lazily on the first call to `window.brainstorm.dashboard.snapshot()`
 * and then pushes every committed update to this renderer via the
 * `dashboard:snapshot` channel.
 *
 * Returns `null` until the first snapshot arrives (the call also runs at
 * mount so the empty state lasts at most one tick).
 *
 * Re-fetches on unlock: a hard-lock disposes the vault session, so the
 * `snapshot()` call made while locked returns `null` and nothing re-pushes
 * a fresh one once the session is re-opened. Without this the app icons sit
 * blank after a PIN unlock until the next dashboard-doc commit. The re-fetch
 * runs through the same handler, which re-subscribes the new session's store.
 */

import {
	DEFAULT_CHROME,
	DEFAULT_LOCALE,
	DEFAULT_NOTIFICATIONS,
	DEFAULT_REGIONAL,
} from "@brainstorm-os/protocol/shell-prefs";
import { useEffect, useState } from "react";
import type { DashboardSnapshot } from "../../preload";

/**
 * Fill the settings-overhaul snapshot maps when they're absent. A snapshot
 * pushed by a main process that hasn't restarted yet (main/preload don't HMR,
 * unlike the renderer) predates these fields, so a freshly-reloaded renderer
 * would read `snapshot.locale` as `undefined` and crash. Defaulting here keeps
 * every consumer safe regardless of the main-process build version.
 */
function withSettingsDefaults(snap: DashboardSnapshot): DashboardSnapshot {
	return {
		...snap,
		locale: snap.locale ?? DEFAULT_LOCALE,
		regional: snap.regional ?? DEFAULT_REGIONAL,
		chrome: snap.chrome ?? DEFAULT_CHROME,
		notifications: snap.notifications ?? DEFAULT_NOTIFICATIONS,
		notificationHistory: snap.notificationHistory ?? [],
	};
}

export function useDashboard(): DashboardSnapshot | null {
	const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);

	useEffect(() => {
		let cancelled = false;
		const fetchSnapshot = () => {
			void window.brainstorm.dashboard.snapshot().then((snap) => {
				if (!cancelled && snap) setSnapshot(withSettingsDefaults(snap));
			});
		};
		fetchSnapshot();
		const unsubscribe = window.brainstorm.dashboard.on((snap) => {
			setSnapshot(withSettingsDefaults(snap));
		});
		// Guard a stale preload bundle (preload doesn't HMR) — a missing bridge
		// must not crash the dashboard.
		const unsubscribeLock = window.brainstorm.vaults?.onLockChanged?.((payload) => {
			if (!payload.locked) fetchSnapshot();
		});
		return () => {
			cancelled = true;
			unsubscribe();
			unsubscribeLock?.();
		};
	}, []);

	return snapshot;
}
