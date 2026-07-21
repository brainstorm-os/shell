/**
 * Builds a `RecurrenceSummaryLabels` pack for the shared `summarizeRecurrence`
 * keystone. Calendar and Tasks both feed it translated phrases; the only
 * difference between their packs was the `t()` namespace prefix
 * (`calendar.recurrence.*` vs `tasks.recurrence.*`), so this takes a
 * suffix-translator and each app supplies the prefix.
 *
 * Phrase templates come from the caller's i18n manifest; month / weekday
 * names come from the platform locale via `toLocaleDateString` (matching
 * how the apps render the rest of their dates) so summaries need no extra
 * manifest keys.
 */

import type { RecurrenceSummaryLabels } from "@brainstorm-os/sdk-types";

/** Resolves a recurrence phrase by its key *suffix* (e.g. `"everyNDays"`,
 *  `"ordinal.first"`) within the caller's own namespace. */
export type RecurrenceTranslate = (key: string, params?: Record<string, string | number>) => string;

// 2024-01-01 is a Monday → deterministic anchor for short weekday names.
const WEEKDAY_ANCHOR = Date.UTC(2024, 0, 1);

function shortWeekday(offsetFromMon: number): string {
	return new Date(WEEKDAY_ANCHOR + offsetFromMon * 86_400_000).toLocaleDateString(undefined, {
		weekday: "short",
	});
}

export function buildRecurrenceLabels(translate: RecurrenceTranslate): RecurrenceSummaryLabels {
	return {
		daily: translate("daily"),
		everyNDays: (n) => translate("everyNDays", { n }),
		weeklyOn: (days) => translate("weeklyOn", { days }),
		everyNWeeksOn: (n, days) => translate("everyNWeeksOn", { n, days }),
		monthlyOnDay: (day) => translate("monthlyOnDay", { day }),
		everyNMonthsOnDay: (n, day) => translate("everyNMonthsOnDay", { n, day }),
		monthlyOnWeekday: (ordinal, weekday) => translate("monthlyOnWeekday", { ordinal, weekday }),
		everyNMonthsOnWeekday: (n, ordinal, weekday) =>
			translate("everyNMonthsOnWeekday", { n, ordinal, weekday }),
		yearlyOn: (month, day) => translate("yearlyOn", { month, day }),
		custom: translate("custom"),
		none: translate("none"),
		weekdayShort: {
			mon: shortWeekday(0),
			tue: shortWeekday(1),
			wed: shortWeekday(2),
			thu: shortWeekday(3),
			fri: shortWeekday(4),
			sat: shortWeekday(5),
			sun: shortWeekday(6),
		},
		monthName: (m) => new Date(2000, m - 1, 1).toLocaleDateString(undefined, { month: "long" }),
		ordinal: {
			"1": translate("ordinal.first"),
			"2": translate("ordinal.second"),
			"3": translate("ordinal.third"),
			"4": translate("ordinal.fourth"),
			"-1": translate("ordinal.last"),
		},
		listSeparator: translate("listSeparator"),
	};
}
