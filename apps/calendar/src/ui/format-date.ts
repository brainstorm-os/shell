/**
 * Human-friendly date / time / range formatters used across all four
 * Calendar views.
 *
 * Same shape as `apps/tasks/src/ui/format-date.ts`: relative anchors
 * resolved against a `now` argument so the demo + production agree
 * with their respective time anchors. Locale-aware via
 * `toLocaleDateString` / `toLocaleTimeString`; falls back gracefully
 * when the host can't resolve the locale.
 */

import { formatGroupDate, formatRelativeDate } from "@brainstorm-os/sdk/date-formatters";
import { type TKey, t } from "../i18n/t";
import { endOfMonth, endOfWeek, isSameMonth, startOfMonth, startOfWeek } from "../logic/date-range";
import { CalendarViewKind } from "../types/calendar-view";
import type { WeekStartsOn } from "../types/calendar-view";

function relativeLabels() {
	return {
		today: t("calendar.date.today"),
		tomorrow: t("calendar.date.tomorrow"),
		yesterday: t("calendar.date.yesterday"),
	};
}

/** "Today" / "Tomorrow" / "Yesterday" / weekday / "May 28" / "May 28 2027". */
export function formatDateRelative(epochMs: number, now: number): string {
	return formatRelativeDate(epochMs, now, relativeLabels());
}

/** Agenda day-group sub-header — the shared one-shape group format ("Today" /
 *  "Tomorrow" / "Sat 13 Jun"), consistent with the Tasks "Upcoming" headers
 *  (F-041: no relative↔absolute switch mid-list). */
export function formatGroupDateLabel(epochMs: number, now: number): string {
	return formatGroupDate(epochMs, now, relativeLabels());
}

/** Time portion only — "9:30 AM" / "13:00" depending on locale. */
export function formatTime(epochMs: number): string {
	const d = new Date(epochMs);
	return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Time range for a single-day item — "9:30 – 11:00" / "9:30 AM – 11:00 AM". */
export function formatTimeRange(start: number, end: number | null): string {
	if (end === null) return formatTime(start);
	return `${formatTime(start)} – ${formatTime(end)}`;
}

/** The header range label — "May 2026" for Month, "May 11 – 17 2026" for
 *  Week, "Thursday, May 14 2026" for Day, "Upcoming" for Agenda. */
export function formatRangeLabel(
	kind: CalendarViewKind,
	anchor: number,
	weekStartsOn: WeekStartsOn,
): string {
	if (kind === CalendarViewKind.Year) {
		return String(new Date(anchor).getFullYear());
	}
	if (kind === CalendarViewKind.Agenda) {
		return new Date(anchor).toLocaleDateString(undefined, { month: "long", year: "numeric" });
	}
	if (kind === CalendarViewKind.Month) {
		return new Date(anchor).toLocaleDateString(undefined, { month: "long", year: "numeric" });
	}
	if (kind === CalendarViewKind.Day) {
		return new Date(anchor).toLocaleDateString(undefined, {
			weekday: "long",
			month: "long",
			day: "numeric",
			year: "numeric",
		});
	}
	// Week
	const start = startOfWeek(anchor, weekStartsOn);
	const end = endOfWeek(anchor, weekStartsOn);
	if (isSameMonth(start, end)) {
		const month = new Date(start).toLocaleDateString(undefined, { month: "long" });
		const year = new Date(start).getFullYear();
		const startDay = new Date(start).getDate();
		const endDay = new Date(end).getDate();
		return `${month} ${startDay} – ${endDay}, ${year}`;
	}
	const startStr = new Date(start).toLocaleDateString(undefined, { month: "short", day: "numeric" });
	const endStr = new Date(end).toLocaleDateString(undefined, { month: "short", day: "numeric" });
	const year = new Date(end).getFullYear();
	return `${startStr} – ${endStr}, ${year}`;
}

/** The seven weekday short labels in the user's preferred week-start order. */
export function weekdayHeaderLabels(weekStartsOn: WeekStartsOn): string[] {
	const keys: TKey[] = [
		"calendar.weekday.short.sun",
		"calendar.weekday.short.mon",
		"calendar.weekday.short.tue",
		"calendar.weekday.short.wed",
		"calendar.weekday.short.thu",
		"calendar.weekday.short.fri",
		"calendar.weekday.short.sat",
	];
	const start = (weekStartsOn as number) % 7;
	const out: string[] = new Array(7);
	for (let i = 0; i < 7; i++) {
		const key = keys[(start + i) % 7];
		out[i] = key ? t(key) : "";
	}
	return out;
}

/** Anchor for `endOfMonth` exported so the header can show a month-grid-
 *  end label without duplicating the import in calendar-header. */
export { startOfMonth, endOfMonth };
