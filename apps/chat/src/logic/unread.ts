/**
 * Unread tracking for the app-icon badge (7.14 follow-up) — pure functions
 * over the live snapshot plus a per-channel read watermark (the highest
 * `seq` the user has seen in that channel).
 *
 * Seen semantics are app-owned: the ACTIVE channel is continuously read
 * (its watermark rides its max seq while it's open), and a channel observed
 * for the first time is marked read at its current max — so history never
 * badges on first run; only messages that arrive after the app has seen a
 * channel count. Own messages (the local author's `personRef`) never count.
 *
 * Watermarks persist on the synced per-user entity (`user-state.ts`, Chats-2).
 * The app-private `storage.kv` key below is the pre-Chats-2 device-local home:
 * still read once as the migration source, and still the store when the host
 * offers no roster/entities (standalone preview).
 */

import { CHANNEL_TYPE, type EntityLike, MESSAGE_TYPE, toMessage } from "./chat";
import type { KvStore } from "./identity";

export const READ_WATERMARKS_KEY = "chat:read-watermarks";

/** channelId → highest seen `seq`. */
export type ReadWatermarks = Readonly<Record<string, number>>;

/** Defensive decode of a persisted watermark map — keeps only finite numeric
 *  entries so a corrupt value can never poison the unread count. */
export function decodeWatermarks(raw: unknown): ReadWatermarks {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: Record<string, number> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
	}
	return out;
}

export async function loadWatermarks(store: KvStore): Promise<ReadWatermarks> {
	return decodeWatermarks(await store.get(READ_WATERMARKS_KEY));
}

export async function saveWatermarks(store: KvStore, marks: ReadWatermarks): Promise<void> {
	await store.put(READ_WATERMARKS_KEY, marks);
}

/** Highest `seq` per channel from the live snapshot. Channel-resolved
 *  messages only — `brainstorm/Message/v1` is a shared substrate (Agent
 *  transcripts use it too), so only messages whose `conversation` is a live
 *  chat channel participate. Channels with no messages map to -1 (any first
 *  message outranks the ack). */
export function channelMaxSeqs(entities: readonly EntityLike[]): Map<string, number> {
	const maxes = new Map<string, number>();
	for (const e of entities) {
		if (e.type === CHANNEL_TYPE) maxes.set(e.id, maxes.get(e.id) ?? -1);
	}
	for (const e of entities) {
		if (e.type !== MESSAGE_TYPE) continue;
		const m = toMessage(e);
		const current = maxes.get(m.channelId);
		if (current === undefined) continue;
		if (m.seq > current) maxes.set(m.channelId, m.seq);
	}
	return maxes;
}

/** Per-channel count of messages from OTHER authors above that channel's
 *  watermark. A channel absent from `marks` is omitted — it hasn't been
 *  observed yet; the first-observation ack (see `ackChannels`) baselines it.
 *  Channels with nothing unread are omitted too. */
export function unreadByChannel(
	entities: readonly EntityLike[],
	selfRef: string,
	marks: ReadWatermarks,
): Map<string, number> {
	const channelIds = new Set<string>();
	for (const e of entities) {
		if (e.type === CHANNEL_TYPE) channelIds.add(e.id);
	}
	const counts = new Map<string, number>();
	for (const e of entities) {
		if (e.type !== MESSAGE_TYPE) continue;
		const m = toMessage(e);
		if (!channelIds.has(m.channelId)) continue;
		if (m.authorRef === selfRef) continue;
		const mark = marks[m.channelId];
		if (mark === undefined) continue;
		if (m.seq > mark) counts.set(m.channelId, (counts.get(m.channelId) ?? 0) + 1);
	}
	return counts;
}

/** Total of {@link unreadByChannel} — the app-icon badge count. */
export function unreadTotal(
	entities: readonly EntityLike[],
	selfRef: string,
	marks: ReadWatermarks,
): number {
	let total = 0;
	for (const n of unreadByChannel(entities, selfRef, marks).values()) total += n;
	return total;
}

/** Raise the given channels' watermarks to their current max seq. Returns
 *  the SAME reference when nothing changed, so a state setter keyed on
 *  identity doesn't loop. */
export function ackChannels(
	marks: ReadWatermarks,
	maxSeqs: ReadonlyMap<string, number>,
	channelIds: readonly string[],
): ReadWatermarks {
	let next: Record<string, number> | null = null;
	for (const id of channelIds) {
		const max = maxSeqs.get(id);
		if (max === undefined) continue;
		const current = marks[id];
		if (current !== undefined && current >= max) continue;
		next = next ?? { ...marks };
		next[id] = max;
	}
	return next ?? marks;
}
