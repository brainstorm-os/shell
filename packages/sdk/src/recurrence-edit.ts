/**
 * `@brainstorm-os/sdk/recurrence-edit` — pure helpers backing the shared
 * recurrence editor (Calendar 9.15.13, Tasks 9.14.12). The date-anchored
 * defaulting + value-coercion logic lives here so it can be exercised without
 * a renderer and shared by every app that authors a `Recurrence`. Every
 * structured kind seeds from the anchor instant (weekly → anchor weekday,
 * monthly → anchor day-of-month, yearly → anchor month + day).
 *
 * Extracted from `apps/calendar/src/logic/recurrence-edit.ts` at the second
 * consumer ([[feedback_extract_to_sdk_at_copy_two]]); Calendar re-exports it.
 */

import {
	type Recurrence,
	RecurrenceKind,
	type RecurrenceSummaryLabels,
	WEEKDAYS,
	type Weekday,
	isRecurrence,
	summarizeRecurrence,
} from "@brainstorm-os/sdk-types";

/** The kind selector's options — the five structured/custom kinds plus a
 *  leading "none" sentinel (no recurrence). */
export enum RepeatKind {
	None = "none",
	Daily = "daily",
	Weekly = "weekly",
	Monthly = "monthly",
	Yearly = "yearly",
	Custom = "custom",
}

export const REPEAT_KINDS: readonly RepeatKind[] = Object.freeze([
	RepeatKind.None,
	RepeatKind.Daily,
	RepeatKind.Weekly,
	RepeatKind.Monthly,
	RepeatKind.Yearly,
	RepeatKind.Custom,
]);

/** JS `Date.getDay()` (0 = Sun) → the ISO-ordered `Weekday` enum. */
export function weekdayForDate(epochMs: number): Weekday {
	const jsDay = new Date(epochMs).getDay(); // 0 Sun … 6 Sat
	const isoIndex = (jsDay + 6) % 7; // 0 Mon … 6 Sun
	// WEEKDAYS is frozen ISO order (Mon..Sun); index is in range by construction.
	return WEEKDAYS[isoIndex] as Weekday;
}

/** The `RepeatKind` a stored recurrence maps back to (for re-opening an
 *  event for edit). `null` recurrence → `RepeatKind.None`. */
export function repeatKindOf(recurrence: Recurrence | null): RepeatKind {
	if (!recurrence) return RepeatKind.None;
	switch (recurrence.kind) {
		case RecurrenceKind.Daily:
			return RepeatKind.Daily;
		case RecurrenceKind.Weekly:
			return RepeatKind.Weekly;
		case RecurrenceKind.Monthly:
			return RepeatKind.Monthly;
		case RecurrenceKind.Yearly:
			return RepeatKind.Yearly;
		case RecurrenceKind.Custom:
			return RepeatKind.Custom;
	}
}

/** A sensible default `Recurrence` for `kind`, anchored on `start`.
 *  `RepeatKind.None` returns `null`. Custom seeds a weekly RRULE so the
 *  field isn't empty (an empty rrule is structurally invalid). */
export function defaultRecurrenceForKind(kind: RepeatKind, start: number): Recurrence | null {
	const date = new Date(start);
	switch (kind) {
		case RepeatKind.None:
			return null;
		case RepeatKind.Daily:
			return { kind: RecurrenceKind.Daily, every: 1 };
		case RepeatKind.Weekly:
			return { kind: RecurrenceKind.Weekly, every: 1, days: [weekdayForDate(start)] };
		case RepeatKind.Monthly:
			return { kind: RecurrenceKind.Monthly, every: 1, dayOfMonth: date.getDate() };
		case RepeatKind.Yearly:
			return { kind: RecurrenceKind.Yearly, month: date.getMonth() + 1, day: date.getDate() };
		case RepeatKind.Custom:
			return { kind: RecurrenceKind.Custom, rrule: "FREQ=WEEKLY" };
	}
}

/** Clamp a free-typed interval to an integer ≥ 1. */
export function clampInterval(value: number): number {
	if (!Number.isFinite(value)) return 1;
	return Math.max(1, Math.floor(value));
}

/** Keep only the weekdays present, in canonical ISO order, de-duplicated;
 *  never empty (falls back to the anchor weekday) so a Weekly recurrence
 *  stays structurally valid. */
export function normalizeWeekdays(days: readonly Weekday[], anchor: Weekday): Weekday[] {
	const present = new Set(days);
	const ordered = WEEKDAYS.filter((d) => present.has(d));
	return ordered.length > 0 ? ordered : [anchor];
}

/** Final validation gate — returns the recurrence only if it's
 *  structurally valid, else `null` (mirrors the codec's boundary check so
 *  the editor never hands a half-built value to the save path). */
export function coerceRecurrence(value: Recurrence | null): Recurrence | null {
	if (value === null) return null;
	return isRecurrence(value) ? value : null;
}

/** The helper caption under the recurrence kind select, or `null` when it
 *  would only echo what the select already says (F-153): no caption for the
 *  no-repeat default, and none when the resolved summary is identical to the
 *  selected kind's own option label. */
export function recurrenceCaption(
	value: Recurrence | null,
	selectedKindLabel: string,
	summaryLabels: RecurrenceSummaryLabels,
): string | null {
	const summary = summarizeRecurrence(value, summaryLabels);
	if (summary === summaryLabels.none) return null;
	if (summary === selectedKindLabel) return null;
	return summary;
}
