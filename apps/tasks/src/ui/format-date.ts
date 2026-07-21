/**
 * Human-friendly date formatter for Tasks rows + section headers.
 * Returns short strings like "Today", "Tomorrow", "Yesterday", "Fri",
 * "May 28", or "May 28, 2027" depending on how far the date is from `now`.
 *
 * Thin wrapper over `@brainstorm-os/sdk/date-formatters` (shared with
 * Calendar): the Tasks variant shows a short weekday only for the upcoming
 * 2–6 days and is locale-aware.
 */

import { formatGroupDate, formatRelativeDate } from "@brainstorm-os/sdk/date-formatters";
import { t } from "../i18n/t";

function labels() {
	return {
		today: t("tasks.date.today"),
		tomorrow: t("tasks.date.tomorrow"),
		yesterday: t("tasks.date.yesterday"),
	};
}

export function formatDateRelative(epochMs: number, now: number): string {
	return formatRelativeDate(epochMs, now, labels(), {
		weekdayBackDays: 1,
		weekdayForwardDays: 6,
		weekdayStyle: "short",
	});
}

/** "Upcoming" section header — the shared one-shape group format ("Today" /
 *  "Tomorrow" / "Sat 13 Jun"), identical to the Calendar agenda day headers
 *  (F-041: one date language, an unambiguous day-of-month, no bare "SAT"). */
export function formatGroupDateLabel(epochMs: number, now: number): string {
	return formatGroupDate(epochMs, now, labels());
}
