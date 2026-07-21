/**
 * Human summary of a `Recurrence` — "Every 2 weeks on Mon, Wed",
 * "Yearly on Mar 14", "Monthly on the last Friday".
 *
 * The 9.15.5 engine answers *when*; this answers *what to call it* for
 * a chip aria-label / tooltip / the recurrence editor's live preview.
 * Calendar's event chip currently shows a bare "↻" with a static
 * aria-label regardless of the pattern — this is the shared, tested
 * primitive that replaces every such ad-hoc rendering.
 *
 * Pure + leaf (imports only `./recurrence`). i18n is the caller's job:
 * every user-visible fragment is supplied via the `labels` object
 * (closures for the parametric cases), exactly the injected-labels
 * convention `@brainstorm-os/sdk`'s `<InlinePropertyForm>` established —
 * sdk-types bundles no UI English beyond the convenience
 * `DEFAULT_RECURRENCE_LABELS` pack (used by tests + as a sane fallback,
 * the same role `@brainstorm-os/sdk/i18n` common-labels plays).
 */

import {
	type MonthlyRecurrence,
	type Recurrence,
	RecurrenceKind,
	WEEKDAYS,
	type Weekday,
	type WeeklyRecurrence,
} from "./recurrence";

export type OrdinalKey = "1" | "2" | "3" | "4" | "-1";

export interface RecurrenceSummaryLabels {
	/** every === 1 */
	daily: string;
	everyNDays: (n: number) => string;
	weeklyOn: (days: string) => string;
	everyNWeeksOn: (n: number, days: string) => string;
	monthlyOnDay: (day: number) => string;
	everyNMonthsOnDay: (n: number, day: number) => string;
	monthlyOnWeekday: (ordinal: string, weekday: string) => string;
	everyNMonthsOnWeekday: (n: number, ordinal: string, weekday: string) => string;
	yearlyOn: (month: string, day: number) => string;
	custom: string;
	/** Empty / unrecognised input. */
	none: string;
	weekdayShort: Readonly<Record<Weekday, string>>;
	/** 1..12 → display name. */
	monthName: (month1to12: number) => string;
	ordinal: Readonly<Record<OrdinalKey, string>>;
	listSeparator: string;
}

/** English convenience pack — a fallback + the test fixture, never the
 *  required path (callers pass their own `t()`-translated labels). */
export const DEFAULT_RECURRENCE_LABELS: RecurrenceSummaryLabels = {
	daily: "Every day",
	everyNDays: (n) => `Every ${n} days`,
	weeklyOn: (days) => `Weekly on ${days}`,
	everyNWeeksOn: (n, days) => `Every ${n} weeks on ${days}`,
	monthlyOnDay: (day) => `Monthly on day ${day}`,
	everyNMonthsOnDay: (n, day) => `Every ${n} months on day ${day}`,
	monthlyOnWeekday: (ordinal, weekday) => `Monthly on the ${ordinal} ${weekday}`,
	everyNMonthsOnWeekday: (n, ordinal, weekday) => `Every ${n} months on the ${ordinal} ${weekday}`,
	yearlyOn: (month, day) => `Yearly on ${month} ${day}`,
	custom: "Custom recurrence",
	none: "Does not repeat",
	weekdayShort: {
		mon: "Mon",
		tue: "Tue",
		wed: "Wed",
		thu: "Thu",
		fri: "Fri",
		sat: "Sat",
		sun: "Sun",
	},
	monthName: (m) =>
		[
			"January",
			"February",
			"March",
			"April",
			"May",
			"June",
			"July",
			"August",
			"September",
			"October",
			"November",
			"December",
		][m - 1] ?? String(m),
	ordinal: { "1": "first", "2": "second", "3": "third", "4": "fourth", "-1": "last" },
	listSeparator: ", ",
};

function weeklyDays(rec: WeeklyRecurrence, labels: RecurrenceSummaryLabels): string {
	const set = new Set(rec.days);
	// Render in canonical ISO order so the output is stable regardless
	// of how the days were authored.
	return WEEKDAYS.filter((d) => set.has(d))
		.map((d) => labels.weekdayShort[d])
		.join(labels.listSeparator);
}

function monthlySummary(rec: MonthlyRecurrence, labels: RecurrenceSummaryLabels): string {
	const every = Math.max(1, Math.floor(rec.every));
	if (typeof rec.dayOfMonth === "number") {
		return every === 1
			? labels.monthlyOnDay(rec.dayOfMonth)
			: labels.everyNMonthsOnDay(every, rec.dayOfMonth);
	}
	if (rec.dayOfWeek) {
		const ord = labels.ordinal[String(rec.dayOfWeek.ordinal) as OrdinalKey] ?? "";
		const wd = labels.weekdayShort[rec.dayOfWeek.weekday] ?? "";
		return every === 1
			? labels.monthlyOnWeekday(ord, wd)
			: labels.everyNMonthsOnWeekday(every, ord, wd);
	}
	return labels.custom;
}

/**
 * One-line human summary of `recurrence`. A non-object / unrecognised
 * `kind` yields `labels.none` (never throws — a malformed
 * `Task.recurrence` degrades gracefully, same posture as `isRecurrence`).
 */
export function summarizeRecurrence(
	recurrence: Recurrence | null | undefined,
	labels: RecurrenceSummaryLabels = DEFAULT_RECURRENCE_LABELS,
): string {
	if (!recurrence || typeof recurrence !== "object") return labels.none;
	switch (recurrence.kind) {
		case RecurrenceKind.Daily: {
			const every = Math.max(1, Math.floor(recurrence.every));
			return every === 1 ? labels.daily : labels.everyNDays(every);
		}
		case RecurrenceKind.Weekly: {
			const every = Math.max(1, Math.floor(recurrence.every));
			const days = weeklyDays(recurrence, labels);
			return every === 1 ? labels.weeklyOn(days) : labels.everyNWeeksOn(every, days);
		}
		case RecurrenceKind.Monthly:
			return monthlySummary(recurrence, labels);
		case RecurrenceKind.Yearly:
			return labels.yearlyOn(labels.monthName(recurrence.month), recurrence.day);
		case RecurrenceKind.Custom:
			return labels.custom;
		default:
			return labels.none;
	}
}
