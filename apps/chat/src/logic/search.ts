/**
 * Chats-1 — message search over the live snapshot.
 *
 * Chat already holds every channel + message row in its `useVaultEntities`
 * snapshot (it needs them for the transcript and the unread badge), so search
 * is an in-app scan of that snapshot rather than a round-trip to the vault
 * search service — which would need a new `search.*` capability and does not
 * index `Message/v1` bodies by channel. The scan is bounded twice: results stop
 * at {@link SEARCH_RESULT_LIMIT} (newest first), and a query shorter than
 * {@link SEARCH_MIN_QUERY} returns nothing so a single keystroke never walks
 * the whole history.
 */

import { CHANNEL_TYPE, type EntityLike, MESSAGE_TYPE, toChannel, toMessage } from "./chat";

export const SEARCH_RESULT_LIMIT = 50;
export const SEARCH_MIN_QUERY = 2;
const SNIPPET_RADIUS = 48;

export enum SearchScope {
	Channel = "channel",
	All = "all",
}

export type SearchHit = {
	messageId: string;
	channelId: string;
	channelName: string;
	authorName: string;
	createdAt: string;
	seq: number;
	snippet: string;
};

/** Lower-cased whitespace-separated terms; every term must appear in a hit. */
export function queryTerms(query: string): string[] {
	return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** A window of `body` around the first term's match, ellipsised at cut edges
 *  and whitespace-collapsed so a multi-line message reads as one result line. */
export function snippetFor(body: string, terms: readonly string[]): string {
	const flat = body.replace(/\s+/g, " ").trim();
	const first = terms[0];
	const at = first ? flat.toLowerCase().indexOf(first) : -1;
	if (at < 0 || flat.length <= SNIPPET_RADIUS * 2) return flat.slice(0, SNIPPET_RADIUS * 2);
	const start = Math.max(0, at - SNIPPET_RADIUS);
	const end = Math.min(flat.length, at + (first?.length ?? 0) + SNIPPET_RADIUS);
	return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

export function searchMessages(
	entities: readonly EntityLike[],
	query: string,
	options: { scope: SearchScope; channelId: string | null; limit?: number },
): SearchHit[] {
	if (query.trim().length < SEARCH_MIN_QUERY) return [];
	const terms = queryTerms(query);
	if (options.scope === SearchScope.Channel && !options.channelId) return [];
	const channelNames = new Map<string, string>();
	for (const e of entities) {
		if (e.type === CHANNEL_TYPE) channelNames.set(e.id, toChannel(e).name);
	}
	const hits: SearchHit[] = [];
	for (const e of entities) {
		if (e.type !== MESSAGE_TYPE) continue;
		const m = toMessage(e);
		const channelName = channelNames.get(m.channelId);
		if (channelName === undefined) continue;
		if (options.scope === SearchScope.Channel && m.channelId !== options.channelId) continue;
		const haystack = m.body.toLowerCase();
		if (!terms.every((term) => haystack.includes(term))) continue;
		hits.push({
			messageId: m.id,
			channelId: m.channelId,
			channelName,
			authorName: m.authorName,
			createdAt: m.createdAt,
			seq: m.seq,
			snippet: snippetFor(m.body, terms),
		});
	}
	hits.sort(
		(a, b) =>
			b.createdAt.localeCompare(a.createdAt) ||
			b.seq - a.seq ||
			a.messageId.localeCompare(b.messageId),
	);
	return hits.slice(0, options.limit ?? SEARCH_RESULT_LIMIT);
}
