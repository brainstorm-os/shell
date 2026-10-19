/**
 * Chats-4 — pinned messages, stored ON the channel as an ordered list of
 * message ids (`Channel/v1.pinned`, oldest pin first). On the channel rather
 * than on each message so every member sees the same pin board and a pin
 * needs no write to a row another member authored.
 *
 * The list is bounded so a hostile or corrupt channel row can't make the
 * header menu unbounded; ids that no longer resolve to a message in the
 * channel (deleted, not yet synced) are skipped at read time, not pruned.
 */

import type { ChatMessage } from "./chat";

export const PINNED_MAX = 50;

export function readPinned(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const id of raw) {
		if (typeof id !== "string" || !id || seen.has(id)) continue;
		seen.add(id);
		out.push(id);
		if (out.length >= PINNED_MAX) break;
	}
	return out;
}

/** Pin (append) or unpin `messageId`. Pinning past the cap drops the oldest. */
export function togglePin(pinned: readonly string[], messageId: string): string[] {
	return setPinned(pinned, messageId, !pinned.includes(messageId));
}

/** Idempotent pin/unpin. The intent is fixed by what the user saw; applying
 *  it to the freshest list (rather than re-toggling) keeps another member's
 *  concurrent pin instead of overwriting it with a stale copy. */
export function setPinned(pinned: readonly string[], messageId: string, pin: boolean): string[] {
	const has = pinned.includes(messageId);
	if (!pin) return has ? pinned.filter((id) => id !== messageId) : [...pinned];
	if (has) return [...pinned];
	const next = [...pinned, messageId];
	return next.length > PINNED_MAX ? next.slice(next.length - PINNED_MAX) : next;
}

/** The channel's pinned messages that resolve, most recently pinned first. */
export function pinnedMessages(
	pinned: readonly string[],
	messages: readonly ChatMessage[],
): ChatMessage[] {
	const byId = new Map(messages.map((m) => [m.id, m]));
	const out: ChatMessage[] = [];
	for (let i = pinned.length - 1; i >= 0; i--) {
		const m = byId.get(pinned[i] ?? "");
		if (m) out.push(m);
	}
	return out;
}
