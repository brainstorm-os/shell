/**
 * Pure data-shaping for the Agent "recent-conversations" dashboard widget —
 * no React / CSS imports, so it's unit-testable in isolation. `widget.tsx` is
 * a thin presentational shell over `shapeConversations` (mirrors the
 * Contacts / Journal widget split).
 *
 * Recency: the full app sorts by id (time-sortable ULIDs — creation order);
 * the glance tile sorts by `updatedAt` desc instead, because a follow-up
 * message bumps it — "last active" is the better signal for a dashboard tile.
 */

import { CONVERSATION_TYPE_URL, type VaultEntitiesListQuery } from "@brainstorm-os/sdk-types";
import { formatRelativeDate } from "@brainstorm-os/sdk/date-formatters";
import { t } from "./i18n";

/** Manifest widget id — must match `registrations.widgets[].id` in manifest.json. */
export const AGENT_WIDGET_RECENT = "recent-conversations";

/** How many conversations the glance list shows. */
export const LIST_LIMIT = 8;

/** Stable query reference for `useVaultEntities` — a new object identity per
 *  render would re-subscribe the store. */
export const AGENT_WIDGET_QUERY: VaultEntitiesListQuery = { types: [CONVERSATION_TYPE_URL] };

/** The minimal vault-entity shape the widget reads (a subset of the live
 *  snapshot's rows) — kept local so the shaper is testable without the full
 *  `react-yjs` entity type. */
export type WidgetConversationEntity = {
	id: string;
	type: string;
	properties: Record<string, unknown>;
	updatedAt: number;
	deletedAt: number | null;
};

export type WidgetConversation = { id: string; title: string; updated: string };

export function conversationTitle(properties: Record<string, unknown>): string {
	const title = properties.title;
	return typeof title === "string" && title.trim().length > 0 ? title : t("chat.untitled");
}

/** The dim second line: a relative "updated" stamp via the shared SDK
 *  relative-date formatter (today / yesterday / weekday / locale month-day). */
export function updatedLabel(updatedAt: number, now: number): string {
	return t("widget.updated", {
		date: formatRelativeDate(updatedAt, now, {
			today: t("widget.date.today"),
			tomorrow: t("widget.date.tomorrow"),
			yesterday: t("widget.date.yesterday"),
		}),
	});
}

/** Filter the live snapshot to non-deleted `Conversation/v1`, order by
 *  newest-updated first, and project the top `limit` into glance rows.
 *  `total` is the full live-conversation count (independent of the limit). */
export function shapeConversations(
	entities: readonly WidgetConversationEntity[],
	now: number,
	limit = LIST_LIMIT,
): { conversations: WidgetConversation[]; total: number } {
	const live = entities.filter((e) => e.type === CONVERSATION_TYPE_URL && e.deletedAt === null);
	const ordered = [...live].sort((a, b) => b.updatedAt - a.updatedAt);
	const conversations = ordered.slice(0, limit).map((e) => ({
		id: e.id,
		title: conversationTitle(e.properties),
		updated: updatedLabel(e.updatedAt, now),
	}));
	return { conversations, total: live.length };
}
