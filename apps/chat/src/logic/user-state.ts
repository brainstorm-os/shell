/**
 * Chats-2/3 — the per-user Chat state that FOLLOWS the user across devices:
 * read watermarks (Chats-2) and display preferences (Chats-3).
 *
 * It lives on an app-owned vault entity (`io.brainstorm.chat/UserState/v1`)
 * keyed by the member's sovereign pubkey, because the SDK has no synced kv:
 * `storage.kv` and `settings` are both device-local by design. A vault entity
 * rides the owner's own device sync; it is never placed in a shared channel
 * collection, so a collaborator never receives another member's read state.
 *
 * Two devices that both boot before either has synced each create a row, so
 * readers MERGE every row the owner has: watermarks take the per-channel max
 * (a watermark only ever moves forward, so max is the correct CRDT join) and
 * preferences come from the most recently written row. Writes go to the
 * lowest-id row so both devices converge on the same target.
 */

import { SystemEntityType } from "@brainstorm-os/sdk/system-entities";
import type { EntityLike } from "./chat";
import { type ReadWatermarks, decodeWatermarks } from "./unread";

export const USER_STATE_TYPE = SystemEntityType.ChatUserState;

export type ChatPrefs = {
	/** Show a full date + time on every message instead of the
	 *  Today / Yesterday day labels and a bare clock time. */
	absoluteTimestamps: boolean;
};

export const DEFAULT_PREFS: ChatPrefs = { absoluteTimestamps: false };

export type UserState = {
	/** The row a write targets, or null when the owner has none yet. */
	primaryId: string | null;
	watermarks: ReadWatermarks;
	prefs: ChatPrefs;
};

export const EMPTY_USER_STATE: UserState = {
	primaryId: null,
	watermarks: {},
	prefs: DEFAULT_PREFS,
};

function decodePrefs(raw: unknown): ChatPrefs {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_PREFS;
	const p = raw as Record<string, unknown>;
	return {
		absoluteTimestamps:
			typeof p.absoluteTimestamps === "boolean"
				? p.absoluteTimestamps
				: DEFAULT_PREFS.absoluteTimestamps,
	};
}

/** Per-channel max of two watermark maps. Returns `a` itself when `b` raises
 *  nothing, so an identity-keyed effect doesn't loop. */
export function maxMergeWatermarks(a: ReadWatermarks, b: ReadWatermarks): ReadWatermarks {
	let next: Record<string, number> | null = null;
	for (const [id, seq] of Object.entries(b)) {
		const current = a[id];
		if (current !== undefined && current >= seq) continue;
		next = next ?? { ...a };
		next[id] = seq;
	}
	return next ?? a;
}

export function readUserState(entities: readonly EntityLike[], ownerRef: string): UserState {
	if (!ownerRef) return EMPTY_USER_STATE;
	const rows = entities
		.filter((e) => e.type === USER_STATE_TYPE && e.properties.owner === ownerRef)
		.sort((a, b) => a.id.localeCompare(b.id));
	const first = rows[0];
	if (!first) return EMPTY_USER_STATE;
	let watermarks: ReadWatermarks = {};
	let prefs = DEFAULT_PREFS;
	let prefsAt = "";
	for (const row of rows) {
		watermarks = maxMergeWatermarks(watermarks, decodeWatermarks(row.properties.watermarks));
		const at = typeof row.properties.updatedAt === "string" ? row.properties.updatedAt : "";
		if (row.properties.prefs !== undefined && at >= prefsAt) {
			prefs = decodePrefs(row.properties.prefs);
			prefsAt = at;
		}
	}
	return { primaryId: first.id, watermarks, prefs };
}

export function buildUserStateProperties(args: {
	owner: string;
	watermarks: ReadWatermarks;
	prefs: ChatPrefs;
	updatedAt: string;
}): Record<string, unknown> {
	return {
		owner: args.owner,
		watermarks: { ...args.watermarks },
		prefs: { ...args.prefs },
		updatedAt: args.updatedAt,
	};
}
