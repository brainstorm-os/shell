/**
 * Pure data-shaping for the Chat dashboard widget — no React / CSS imports, so
 * it unit-tests in isolation. The `widget.tsx` component is a thin
 * presentational shell over `shapeRecentMessages`.
 *
 * The one subtlety: `brainstorm/Message/v1` is a *shared* substrate — the
 * Agent app stores its transcript turns as the same type, with `conversation`
 * pointing at a `brainstorm/Conversation/v1` instead of a chat channel. The
 * widget therefore keeps ONLY messages whose `conversation` resolves to a
 * live `io.brainstorm.chat/Channel/v1` in the snapshot; anything else is an
 * agent transcript (or an orphan) and must not leak into the glance tile.
 */

import type { VaultEntitiesListQuery } from "@brainstorm-os/sdk-types";
import { CHANNEL_TYPE, MESSAGE_TYPE, sortMessages, toMessage } from "./logic/chat";

/** Manifest widget id — must match `registrations.widgets[].id` in manifest.json. */
export const CHAT_WIDGET_RECENT = "recent-messages";

/** How many recent messages the glance list shows. */
export const RECENT_LIMIT = 8;

/** Snippet hard cap — CSS ellipsizes the visible line; this just keeps a huge
 *  pasted body from riding along in the shaped rows. */
const SNIPPET_MAX = 160;

/** Stable module-level query so `useVaultEntities` doesn't re-subscribe per
 *  render — the widget bridge narrows the snapshot to these types (F-384). */
export const CHAT_WIDGET_QUERY: VaultEntitiesListQuery = {
	types: [MESSAGE_TYPE, CHANNEL_TYPE],
};

/** One glance row: who said what, where. Click-through opens the channel. */
export type WidgetMessageRow = {
	id: string;
	channelId: string;
	channelName: string;
	sender: string;
	snippet: string;
};

/** The minimal vault-entity shape the widget reads (a structural subset of the
 *  live snapshot's rows) — kept local so the shaper tests against plain
 *  objects. Ordering comes from `properties.seq` / `properties.createdAt`
 *  (an ISO string), not the row's `updatedAt`. */
export type WidgetChatEntity = {
	id: string;
	type: string;
	properties: Record<string, unknown>;
	deletedAt: number | null;
};

/** Collapse a message body to a single display line. */
export function messageSnippet(body: string): string {
	return body.replace(/\s+/g, " ").trim().slice(0, SNIPPET_MAX);
}

/** Filter the live snapshot to non-deleted chat messages (channel-resolved
 *  only — see the module comment), order newest first by the app's canonical
 *  `seq` → `createdAt` → id comparator, and project the top `limit` into
 *  glance rows. `channelCount` is the live channel count (independent of the
 *  limit and of whether a channel has messages yet). */
export function shapeRecentMessages(
	entities: readonly WidgetChatEntity[],
	limit = RECENT_LIMIT,
): { rows: WidgetMessageRow[]; channelCount: number } {
	const channelNames = new Map<string, string>();
	for (const e of entities) {
		if (e.type === CHANNEL_TYPE && e.deletedAt === null) {
			const name = e.properties.name;
			channelNames.set(e.id, typeof name === "string" && name.trim() ? name : "untitled");
		}
	}

	const messages = entities
		.filter((e) => e.type === MESSAGE_TYPE && e.deletedAt === null)
		.map(toMessage)
		.filter((m) => channelNames.has(m.channelId));

	const rows = sortMessages(messages)
		.reverse()
		.slice(0, limit)
		.map((m) => ({
			id: m.id,
			channelId: m.channelId,
			channelName: channelNames.get(m.channelId) ?? "",
			sender: m.authorName,
			snippet: messageSnippet(m.body),
		}));

	return { rows, channelCount: channelNames.size };
}
