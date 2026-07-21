/**
 * Birthday projection — the "next upcoming birthday" for a person, computed
 * from the single stored `Person.birthday` instant via the ONE shared yearly
 * recurrence model (`birthdayOccurrencesInRange`, OQ-CT-3 / OQ-CAL-2). Calendar
 * and the Database Birthdays view derive the same day-of-year from the same
 * helper, so a contact's birthday lands on an identical date everywhere
 * (including the Feb-29 → Feb-28 non-leap clamp). Pure — unit-tested.
 */

import { birthdayOccurrencesInRange } from "@brainstorm-os/sdk-types";

const DAY_MS = 86_400_000;

export type NextBirthday = {
	/** The occurrence instant from the shared recurrence model. */
	atMs: number;
	/** Whole days from today (0 = today, 1 = tomorrow). */
	daysUntil: number;
	/** The age the person turns on this birthday, or null when the stored
	 *  year is in the future / equal (no meaningful age). */
	ageTurning: number | null;
};

/** The next occurrence of any yearly anchor date (birthday, anniversary, …) —
 *  the "years since" the consumer derives differs per kind. */
export type NextYearly = {
	/** The occurrence instant from the shared recurrence model. */
	atMs: number;
	/** Whole days from today (0 = today, 1 = tomorrow). */
	daysUntil: number;
	/** Whole years since the anchor's stored year, or null when the stored
	 *  year is in the future / equal (no meaningful elapsed count). */
	yearsSince: number | null;
};

function startOfLocalDay(ms: number): number {
	const d = new Date(ms);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

type YearlyOccurrence = {
	atMs: number;
	daysUntil: number;
	anchorYear: number;
	occYear: number;
};

/** The next yearly occurrence of `anchorMs` at or after today, via the ONE
 *  shared recurrence model — birthdays and anniversaries both ride this so a
 *  date lands identically wherever it's projected (incl. the Feb-29 → Feb-28
 *  non-leap clamp). `null` for an unusable anchor. */
function nextYearlyOccurrence(anchorMs: number | null, now: number): YearlyOccurrence | null {
	if (anchorMs == null || !Number.isFinite(anchorMs)) return null;
	const today = startOfLocalDay(now);
	// A ~13-month window always contains this year's remaining occurrence or
	// next year's, wherever `now` falls.
	const occurrences = birthdayOccurrencesInRange(anchorMs, today, today + 400 * DAY_MS);
	const next = occurrences.find((o) => startOfLocalDay(o) >= today);
	if (next === undefined) return null;
	const daysUntil = Math.round((startOfLocalDay(next) - today) / DAY_MS);
	return {
		atMs: next,
		daysUntil,
		anchorYear: new Date(anchorMs).getFullYear(),
		occYear: new Date(next).getFullYear(),
	};
}

/** The next birthday at or after today, or `null` for an unusable anchor. */
export function nextBirthday(birthdayMs: number | null, now: number): NextBirthday | null {
	const o = nextYearlyOccurrence(birthdayMs, now);
	if (o === null) return null;
	const ageTurning = o.occYear - o.anchorYear;
	return { atMs: o.atMs, daysUntil: o.daysUntil, ageTurning: ageTurning > 0 ? ageTurning : null };
}

/** The next wedding/relationship anniversary at or after today, or `null` for
 *  an unusable anchor — the second yearly-recurrence date a person carries,
 *  sharing the birthday engine. */
export function nextAnniversary(anniversaryMs: number | null, now: number): NextYearly | null {
	const o = nextYearlyOccurrence(anniversaryMs, now);
	if (o === null) return null;
	const yearsSince = o.occYear - o.anchorYear;
	return { atMs: o.atMs, daysUntil: o.daysUntil, yearsSince: yearsSince > 0 ? yearsSince : null };
}

/** Whether a person's next birthday falls within `windowDays` from today —
 *  drives the list's "Upcoming birthdays" section. */
export function isBirthdaySoon(next: NextBirthday | null, windowDays: number): boolean {
	return next !== null && next.daysUntil >= 0 && next.daysUntil <= windowDays;
}
