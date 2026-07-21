/**
 * Pure data-shaping for the Mailbox `inbox` dashboard widget — no React / CSS
 * imports, so it's unit-testable in isolation. `widget.tsx` is a thin
 * presentational shell over `shapeInbox`. Reuses the app's pure `Email/v1`
 * projection (`toMessageView` / `senderLabel` from `logic/mail-view`) so flag
 * parsing (the `MailFlag` enum guard) and the sender name→address fallback
 * live in exactly one place.
 */

import type { VaultEntitiesListQuery } from "@brainstorm-os/sdk-types";
import { t } from "./i18n";
import { senderLabel, toMessageView } from "./logic/mail-view";
import { EMAIL_TYPE_URL, type MessageView } from "./types/mail-view";

/** Manifest widget id — must match `registrations.widgets[].id` in manifest.json. */
export const MAILBOX_WIDGET_INBOX = "inbox";

/** Default number of messages the glance list shows. */
export const LIST_LIMIT = 8;

/** Server-side narrowing for the widget's live snapshot. Module-level so the
 *  reference stays stable across renders — a fresh object identity per render
 *  would re-subscribe the query store. */
export const MAILBOX_WIDGET_QUERY: VaultEntitiesListQuery = { types: [EMAIL_TYPE_URL] };

/** The minimal vault-entity shape the widget reads (a subset of the live
 *  snapshot's rows) — kept local so the shaper is testable without the full
 *  `react-yjs` entity type. */
export type WidgetEmailEntity = {
	id: string;
	type: string;
	properties: Record<string, unknown>;
	deletedAt: number | null;
};

export type WidgetEmailRow = {
	id: string;
	sender: string;
	subject: string;
	receivedAt: number;
	unread: boolean;
};

function toRow(msg: MessageView): WidgetEmailRow {
	return {
		id: msg.id,
		sender: senderLabel(msg) || t("list.noSender"),
		subject: msg.subject.trim() || t("list.noSubject"),
		receivedAt: msg.receivedAt,
		unread: msg.unread,
	};
}

/** Filter the live snapshot to non-deleted `Email/v1`, order unread-first
 *  (each group newest `receivedAt` first), and project the top `limit` into
 *  glance rows. `unread` / `total` count the full live set (independent of
 *  the limit). */
export function shapeInbox(
	entities: readonly WidgetEmailEntity[],
	limit = LIST_LIMIT,
): { rows: WidgetEmailRow[]; unread: number; total: number } {
	const newestFirst = entities
		.filter((e) => e.type === EMAIL_TYPE_URL && e.deletedAt === null)
		.map(toMessageView)
		.sort((a, b) => b.receivedAt - a.receivedAt);
	const unreadMessages = newestFirst.filter((m) => m.unread);
	const readMessages = newestFirst.filter((m) => !m.unread);
	const rows = [...unreadMessages, ...readMessages].slice(0, limit).map(toRow);
	return { rows, unread: unreadMessages.length, total: newestFirst.length };
}
