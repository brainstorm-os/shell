/**
 * `nextOccurrence(rec, after)` — the next instant strictly greater than
 * `after`, or `null` when the structured form can't expand (`Custom`
 * RRULE has no in-tree parser).
 *
 * Extracted to `@brainstorm-os/sdk-types` (the home of the `Recurrence`
 * union + the 9.15.5 `occurrencesInRange` range-materializer): Tasks'
 * `logic/next-occurrence.ts` carried this verbatim with a comment that
 * "the SDK extracts this directly when it lands — there is no parallel
 * recurrence engine to keep in sync". 9.15.5 introduced exactly such a
 * parallel engine in sdk-types, so the two now live together. This is
 * the *single-next-step* engine (task check-off: compute the next
 * instance); `occurrencesInRange` is the *window-expansion* engine
 * (calendars/birthdays). Both share `./recurrence` + local-time, DST-
 * safe `Date`-setter stepping.
 *
 * Timezone: computed in the host's local zone (no `Z`-suffixed
 * strings). UTC-locking is a deliberate later decision, tracked in the
 * surface-design ladder.
 */

import { type Recurrence, RecurrenceKind, type Weekday } from "./recurrence";

const MS_PER_DAY = 86_400_000;

const WEEKDAY_TO_DOW: Record<Weekday, number> = {
	mon: 1,
	tue: 2,
	wed: 3,
	thu: 4,
	fri: 5,
	sat: 6,
	sun: 0,
} as Record<Weekday, number>;

export function nextOccurrence(rec: Recurrence, after: number): number | null {
	switch (rec.kind) {
		case RecurrenceKind.Daily:
			return nextDaily(rec.every, after);
		case RecurrenceKind.Weekly:
			return nextWeekly(rec.every, rec.days, after);
		case RecurrenceKind.Monthly:
			return nextMonthly(rec, after);
		case RecurrenceKind.Yearly:
			return nextYearly(rec.month, rec.day, after);
		case RecurrenceKind.Custom:
			return null;
	}
}

function nextDaily(every: number, after: number): number {
	return after + every * MS_PER_DAY;
}

function nextWeekly(every: number, days: readonly Weekday[], after: number): number {
	const wanted = new Set<number>(days.map((d) => WEEKDAY_TO_DOW[d]));
	const base = new Date(after);
	const baseWeekStart = startOfIsoWeek(base);
	const maxDays = every * 7 + 7; // bounded walk
	for (let offset = 1; offset <= maxDays; offset++) {
		const probe = new Date(after + offset * MS_PER_DAY);
		if (!wanted.has(probe.getDay())) continue;
		const probeWeekStart = startOfIsoWeek(probe);
		const weeksApart = Math.round(
			(probeWeekStart.getTime() - baseWeekStart.getTime()) / (7 * MS_PER_DAY),
		);
		if (weeksApart === 0) return probe.getTime();
		if (weeksApart % every === 0) return probe.getTime();
	}
	return after + every * 7 * MS_PER_DAY;
}

function nextMonthly(
	rec: Extract<Recurrence, { kind: RecurrenceKind.Monthly }>,
	after: number,
): number {
	const base = new Date(after);
	let probeYear = base.getFullYear();
	let probeMonth = base.getMonth() + 1;
	for (let step = 0; step < 24; step++) {
		const probe = monthlyOccurrenceIn(rec, probeYear, probeMonth, base);
		if (probe !== null && probe.getTime() > after) {
			// probeMonth is 1-based; base.getMonth() is 0-based — subtract 1 so
			// the current calendar month reads as monthsApart=0 rather than 1.
			const monthsApart = (probeYear - base.getFullYear()) * 12 + (probeMonth - base.getMonth() - 1);
			if (monthsApart % rec.every === 0) return probe.getTime();
		}
		probeMonth += 1;
		if (probeMonth > 12) {
			probeMonth = 1;
			probeYear += 1;
		}
	}
	return after;
}

function monthlyOccurrenceIn(
	rec: Extract<Recurrence, { kind: RecurrenceKind.Monthly }>,
	year: number,
	month1Based: number,
	template: Date,
): Date | null {
	if (rec.dayOfMonth !== undefined) {
		const day = clampDayToMonth(year, month1Based, rec.dayOfMonth);
		return new Date(
			year,
			month1Based - 1,
			day,
			template.getHours(),
			template.getMinutes(),
			template.getSeconds(),
			template.getMilliseconds(),
		);
	}
	if (rec.dayOfWeek !== undefined) {
		return nthWeekdayOfMonth(
			year,
			month1Based,
			rec.dayOfWeek.weekday,
			rec.dayOfWeek.ordinal,
			template,
		);
	}
	return null;
}

function nthWeekdayOfMonth(
	year: number,
	month1Based: number,
	weekday: Weekday,
	ordinal: 1 | 2 | 3 | 4 | -1,
	template: Date,
): Date | null {
	const wantedDow = WEEKDAY_TO_DOW[weekday];
	if (ordinal === -1) {
		const lastDay = daysInMonth(year, month1Based);
		for (let day = lastDay; day >= 1; day--) {
			const probe = new Date(
				year,
				month1Based - 1,
				day,
				template.getHours(),
				template.getMinutes(),
				template.getSeconds(),
				template.getMilliseconds(),
			);
			if (probe.getDay() === wantedDow) return probe;
		}
		return null;
	}
	let seen = 0;
	const lastDay = daysInMonth(year, month1Based);
	for (let day = 1; day <= lastDay; day++) {
		const probe = new Date(
			year,
			month1Based - 1,
			day,
			template.getHours(),
			template.getMinutes(),
			template.getSeconds(),
			template.getMilliseconds(),
		);
		if (probe.getDay() === wantedDow) {
			seen += 1;
			if (seen === ordinal) return probe;
		}
	}
	return null;
}

function nextYearly(month: number, day: number, after: number): number {
	const base = new Date(after);
	const thisYear = clampToYear(base.getFullYear(), month, day, base);
	if (thisYear.getTime() > after) return thisYear.getTime();
	return clampToYear(base.getFullYear() + 1, month, day, base).getTime();
}

function clampToYear(year: number, month1Based: number, day: number, template: Date): Date {
	const clampedDay = clampDayToMonth(year, month1Based, day);
	return new Date(
		year,
		month1Based - 1,
		clampedDay,
		template.getHours(),
		template.getMinutes(),
		template.getSeconds(),
		template.getMilliseconds(),
	);
}

function daysInMonth(year: number, month1Based: number): number {
	return new Date(year, month1Based, 0).getDate();
}

function clampDayToMonth(year: number, month1Based: number, day: number): number {
	return Math.min(day, daysInMonth(year, month1Based));
}

/** Monday-start ISO week origin — used to count `every`-week skips. */
function startOfIsoWeek(d: Date): Date {
	const result = new Date(d);
	result.setHours(0, 0, 0, 0);
	const dow = result.getDay(); // 0 = Sun
	const mondayOffset = (dow + 6) % 7;
	result.setDate(result.getDate() - mondayOffset);
	return result;
}
