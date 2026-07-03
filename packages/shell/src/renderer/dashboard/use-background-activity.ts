/**
 * Background-activity renderer hook — subscribes to the privileged
 * `window.brainstorm.activity` push stream (mirrors `useSyncStatus`). Returns
 * the live set of background operations (empty until the first snapshot). One
 * IPC subscription for the whole dashboard.
 */

import { useEffect, useState } from "react";
import type { ActivitySnapshot } from "../../preload";

const EMPTY: ActivitySnapshot = { operations: [] };

export function useBackgroundActivity(): ActivitySnapshot {
	const [snapshot, setSnapshot] = useState<ActivitySnapshot>(EMPTY);

	useEffect(() => {
		let cancelled = false;
		const bridge = window.brainstorm?.activity;
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

	return snapshot;
}
