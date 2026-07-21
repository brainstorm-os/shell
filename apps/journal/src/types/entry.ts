/**
 * Derived projection of a `Note/v1` row when it matches the journal-
 * entry shape (title is a canonical ISO date key). Built by the
 * Journal app's renderer; not persisted separately.
 */

import type { Icon } from "@brainstorm-os/sdk/entity-icon";
import type { ValuesMap } from "@brainstorm-os/sdk/property-ui";
import type { HabitId, MoodId } from "../logic/check-in";

export type JournalEntry = {
	/** Source `Note.id`. */
	noteId: string;
	/** The source note's OWN universal icon (per-object-icons-everywhere);
	 *  `null` when the note has none → the entry header shows the journal
	 *  fallback glyph. */
	icon: Icon | null;
	/** Epoch ms at local midnight on the entry's date. */
	dateEpochMs: number;
	/** Canonical `YYYY-MM-DD` key. */
	dateKey: string;
	/** Original Note title — `2026-05-14` for an auto-titled entry, or
	 *  whatever the user typed if they renamed the note. */
	rawTitle: string;
	/** First-N-char preview of the note body for the date navigator. */
	preview: string;
	/** Word count over the whole body (not the truncated preview) — backs
	 *  the entry footer + properties "N words" (F-012). */
	wordCount: number;
	/** Raw `entity.properties.body` — kept verbatim so the day-body
	 *  editor can plant it into an empty Y.Doc on first mount (mirrors
	 *  Notes' migrate-body for the Journal-first-open path). `null` if
	 *  the body wasn't a recognisable Lexical state. */
	seedBody: unknown;
	/** Bound property values for the source note. Read from the entity's
	 *  `properties.values` bag so the right-hand properties panel can
	 *  render + edit them. Empty when the note has none. */
	values: ValuesMap;
	/** Daily check-in mood (9.16.8) — one point on the 5-step scale, from
	 *  `properties.mood`. `null` when the day has no mood set. */
	mood: MoodId | null;
	/** Habits marked done for the day (9.16.8) — from `properties.habits`,
	 *  in canonical order. Empty when none. */
	habits: HabitId[];
	/** `entity.createdAt` (epoch ms). Surfaced in the properties panel
	 *  metadata block. Falls back to `dateEpochMs` when the source row
	 *  doesn't carry one (the demo dataset). */
	createdAt: number;
	/** `entity.updatedAt` (epoch ms). */
	updatedAt: number;
};
