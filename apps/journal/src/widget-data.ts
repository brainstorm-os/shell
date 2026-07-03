/**
 * Pure data-shaping for the Journal "today-journal" dashboard widget — no
 * React / CSS imports, so it's unit-testable in isolation. `widget.tsx` is a
 * thin presentational shell over `shapeJournalWidget` (mirrors the Contacts
 * widget split).
 *
 * Reuses the app's existing pure helpers rather than re-deriving them:
 * date-key protocol from `logic/journal-keys`, body flattening from
 * `logic/journal-projection`, and the streak walk from `logic/streaks`
 * (whose day arithmetic is UTC-string based, so DST never drifts it).
 */

import type { VaultEntitiesListQuery } from "@brainstorm/sdk-types";
import { compareJournalKeys, dateKeyForJournal, parseJournalDateKey } from "./logic/journal-keys";
import { previewBodyText } from "./logic/journal-projection";
import { currentStreak } from "./logic/streaks";
import { JOURNAL_ENTRY_TYPE } from "./runtime";

/** Manifest widget id — must match `registrations.widgets[].id` in manifest.json. */
export const JOURNAL_WIDGET_TODAY = "today-journal";

/** How many previous days the glance list shows below today. */
export const PREVIOUS_LIMIT = 4;

/** Stable query reference for `useVaultEntities` — a new object identity per
 *  render would re-subscribe the store. */
export const JOURNAL_WIDGET_QUERY: VaultEntitiesListQuery = { types: [JOURNAL_ENTRY_TYPE] };

/** The minimal vault-entity shape the widget reads (a subset of the live
 *  snapshot's rows) — kept local so the shaper is testable without the full
 *  `react-yjs` entity type. */
export type WidgetJournalEntity = {
	id: string;
	type: string;
	properties: Record<string, unknown>;
	deletedAt: number | null;
};

export type WidgetJournalRow = {
	id: string;
	dateKey: string;
	/** Localized short date derived from the `YYYY-MM-DD` key. */
	dateLabel: string;
	snippet: string;
};

export type JournalWidgetModel = {
	/** Today's entry, or null when today is unwritten (no entry / empty body). */
	today: WidgetJournalRow | null;
	/** Up to `PREVIOUS_LIMIT` written days before today, newest first. */
	previous: WidgetJournalRow[];
	/** Consecutive written days ending today — or ending yesterday while today
	 *  is still unwritten, so the chip doesn't read 0 at 8am. */
	streak: number;
};

/** An entry's canonical day — its title, but only when it strictly matches
 *  the `YYYY-MM-DD` protocol (a user-titled note that merely starts with a
 *  date is not a journal day). */
function entryDateKey(properties: Record<string, unknown>): string | null {
	const title = properties.title;
	if (typeof title !== "string") return null;
	return parseJournalDateKey(title) === null ? null : title;
}

/** Localized short date for a day key, e.g. "Jun 30". Falls back to the raw
 *  key for a malformed input (never expected past `entryDateKey`). */
export function dateLabelForKey(dateKey: string): string {
	const epochMs = parseJournalDateKey(dateKey);
	if (epochMs === null) return dateKey;
	return new Date(epochMs).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

type WrittenDay = { id: string; dateKey: string; snippet: string };

function toRow(day: WrittenDay): WidgetJournalRow {
	return {
		id: day.id,
		dateKey: day.dateKey,
		dateLabel: dateLabelForKey(day.dateKey),
		snippet: day.snippet,
	};
}

/** Project the live snapshot into the widget model: today's written entry,
 *  the trailing written days, and the current streak. Days with an empty
 *  body don't count as written — not as rows, not toward the streak. */
export function shapeJournalWidget(
	entities: readonly WidgetJournalEntity[],
	now: number | Date = Date.now(),
): JournalWidgetModel {
	const todayKey = dateKeyForJournal(now);
	const written: WrittenDay[] = [];
	for (const entity of entities) {
		if (entity.type !== JOURNAL_ENTRY_TYPE || entity.deletedAt !== null) continue;
		const dateKey = entryDateKey(entity.properties);
		if (dateKey === null) continue;
		const snippet = previewBodyText(entity.properties.body);
		if (snippet.length === 0) continue;
		written.push({ id: entity.id, dateKey, snippet });
	}

	const streak = currentStreak(new Set(written.map((day) => day.dateKey)), todayKey);
	const today = written.find((day) => day.dateKey === todayKey);
	const previous = written
		.filter((day) => compareJournalKeys(day.dateKey, todayKey) < 0)
		.sort((a, b) => compareJournalKeys(b.dateKey, a.dateKey))
		.slice(0, PREVIOUS_LIMIT)
		.map(toRow);

	return { today: today ? toRow(today) : null, previous, streak };
}
