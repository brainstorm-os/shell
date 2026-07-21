/**
 * Stage 10.13 — selective-sync policy: renderer-safe wire types + the pure
 * admit decision.
 *
 * Per 20-database-growth-and-sync.md §Selective sync:
 * a per-device policy chooses **which shared entities the device actively
 * syncs**. v1 modes:
 *   - **Everything** — every shared entity syncs (desktop default).
 *   - **Pinned** — only user-pinned entities.
 *   - **Pinned + recent N days** — pinned, plus entities active within a
 *     rolling window.
 *
 * Out of scope here (gated on the durable store `SYNC-2`): local eviction +
 * on-demand re-fetch of a not-in-policy entity. At 10.13 the policy gates the
 * live-sync *subscription* only — a not-in-policy shared entity simply isn't
 * subscribed/emitted; its local copy is untouched.
 *
 * Both the renderer (Settings picker) and main (the engine predicate) import
 * this, so it stays free of any `electron` / Node import — the value-import of
 * `SelectiveSyncMode` must not drag preload into the renderer bundle (the
 * CLAUDE.md type-strip trap). Mirrors `sync-status-types.ts`.
 */

export enum SelectiveSyncMode {
	Everything = "everything",
	Pinned = "pinned",
	PinnedPlusRecent = "pinned-plus-recent",
}

export type SelectiveSyncPolicy = {
	mode: SelectiveSyncMode;
	/** Rolling window for `PinnedPlusRecent`; ignored by the other modes. */
	recentDays: number;
};

/** Desktop default per doc 20 §Priority application — "everything". */
export const DEFAULT_SELECTIVE_SYNC_POLICY: SelectiveSyncPolicy = {
	mode: SelectiveSyncMode.Everything,
	recentDays: 30,
};

export const MIN_RECENT_DAYS = 1;
export const MAX_RECENT_DAYS = 3650;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Signals about one entity the policy decision reads. */
export type EntitySyncSignals = {
	/** User-pinned for offline (kept regardless of recency). */
	pinned: boolean;
	/** When the entity was last active (opened/edited), or null if unknown. */
	lastActiveMs: number | null;
};

export function toSelectiveSyncMode(value: unknown): SelectiveSyncMode {
	switch (value) {
		case SelectiveSyncMode.Pinned:
			return SelectiveSyncMode.Pinned;
		case SelectiveSyncMode.PinnedPlusRecent:
			return SelectiveSyncMode.PinnedPlusRecent;
		default:
			return SelectiveSyncMode.Everything;
	}
}

export function clampRecentDays(value: unknown): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) return DEFAULT_SELECTIVE_SYNC_POLICY.recentDays;
	return Math.min(MAX_RECENT_DAYS, Math.max(MIN_RECENT_DAYS, Math.floor(n)));
}

export function normalizeSelectiveSyncPolicy(value: unknown): SelectiveSyncPolicy {
	if (!value || typeof value !== "object") return { ...DEFAULT_SELECTIVE_SYNC_POLICY };
	const raw = value as Record<string, unknown>;
	return {
		mode: toSelectiveSyncMode(raw.mode),
		recentDays: clampRecentDays(raw.recentDays),
	};
}

/**
 * Does the policy admit this entity for active sync? Pure — the engine reads
 * its result per shared entity at open/policy-change time.
 *   - Everything → always.
 *   - Pinned → only if pinned.
 *   - PinnedPlusRecent → pinned, or active within `recentDays` of `nowMs`.
 * A null `lastActiveMs` counts as not-recent (only an explicit pin keeps it).
 */
export function entityMatchesPolicy(
	policy: SelectiveSyncPolicy,
	signals: EntitySyncSignals,
	nowMs: number,
): boolean {
	switch (policy.mode) {
		case SelectiveSyncMode.Everything:
			return true;
		case SelectiveSyncMode.Pinned:
			return signals.pinned;
		case SelectiveSyncMode.PinnedPlusRecent: {
			if (signals.pinned) return true;
			if (signals.lastActiveMs === null) return false;
			return nowMs - signals.lastActiveMs <= policy.recentDays * MS_PER_DAY;
		}
		default:
			return true;
	}
}
