import { RecurrenceKind, Weekday } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { nextOccurrence } from "./next-occurrence";

/** Build a local-tz timestamp at midnight on the given Y/M/D. */
function localDay(year: number, month1Based: number, day: number): number {
	return new Date(year, month1Based - 1, day, 0, 0, 0, 0).getTime();
}

/** Build a local-tz timestamp at hh:mm on the given Y/M/D. */
function localTime(year: number, month1Based: number, day: number, hh: number, mm: number): number {
	return new Date(year, month1Based - 1, day, hh, mm, 0, 0).getTime();
}

describe("nextOccurrence — Daily", () => {
	it("every:1 advances by one day", () => {
		const after = localDay(2026, 5, 14);
		const next = nextOccurrence({ kind: RecurrenceKind.Daily, every: 1 }, after);
		expect(next).toBe(localDay(2026, 5, 15));
	});

	it("every:7 advances by a week", () => {
		const after = localDay(2026, 5, 14);
		const next = nextOccurrence({ kind: RecurrenceKind.Daily, every: 7 }, after);
		expect(next).toBe(localDay(2026, 5, 21));
	});

	it("preserves time-of-day", () => {
		const after = localTime(2026, 5, 14, 9, 30);
		const next = nextOccurrence({ kind: RecurrenceKind.Daily, every: 1 }, after);
		expect(next).toBe(localTime(2026, 5, 15, 9, 30));
	});
});

describe("nextOccurrence — Weekly", () => {
	it("every:1 with a single day in the same week picks that day", () => {
		// 2026-05-14 is a Thursday. Wanted: Friday next.
		const after = localDay(2026, 5, 14);
		const next = nextOccurrence(
			{ kind: RecurrenceKind.Weekly, every: 1, days: [Weekday.Fri] },
			after,
		);
		expect(next).toBe(localDay(2026, 5, 15));
	});

	it("every:1 picks the next listed day in display order, not array order", () => {
		// 2026-05-14 is a Thursday. Days {Mon, Wed, Fri} → next is Fri.
		const after = localDay(2026, 5, 14);
		const next = nextOccurrence(
			{ kind: RecurrenceKind.Weekly, every: 1, days: [Weekday.Fri, Weekday.Mon, Weekday.Wed] },
			after,
		);
		expect(next).toBe(localDay(2026, 5, 15));
	});

	it("every:1 wraps to next week's Monday", () => {
		// 2026-05-14 Thu — only Monday in days → next is 2026-05-18 Mon.
		const after = localDay(2026, 5, 14);
		const next = nextOccurrence(
			{ kind: RecurrenceKind.Weekly, every: 1, days: [Weekday.Mon] },
			after,
		);
		expect(next).toBe(localDay(2026, 5, 18));
	});

	it("every:2 skips a week — Wednesday-of-next-week's-week (= 14 days later)", () => {
		// 2026-05-13 is Wednesday. every:2 with [Wed] should skip Wed 5/20 and pick 5/27.
		const after = localDay(2026, 5, 13);
		const next = nextOccurrence(
			{ kind: RecurrenceKind.Weekly, every: 2, days: [Weekday.Wed] },
			after,
		);
		expect(next).toBe(localDay(2026, 5, 27));
	});
});

describe("nextOccurrence — Monthly (dayOfMonth)", () => {
	it("every:1 picks next month same day", () => {
		const after = localDay(2026, 5, 14);
		const next = nextOccurrence({ kind: RecurrenceKind.Monthly, every: 1, dayOfMonth: 14 }, after);
		expect(next).toBe(localDay(2026, 6, 14));
	});

	it("clamps day-31 onto short months (Feb 2026 = 28d → Feb 28)", () => {
		const after = localDay(2026, 1, 31);
		const next = nextOccurrence({ kind: RecurrenceKind.Monthly, every: 1, dayOfMonth: 31 }, after);
		expect(next).toBe(localDay(2026, 2, 28));
	});

	it("every:3 skips months — Jan 15 → Apr 15", () => {
		const after = localDay(2026, 1, 15);
		const next = nextOccurrence({ kind: RecurrenceKind.Monthly, every: 3, dayOfMonth: 15 }, after);
		expect(next).toBe(localDay(2026, 4, 15));
	});
});

describe("nextOccurrence — Monthly (dayOfWeek)", () => {
	it("third Tuesday of this month when still in the future — May 14 → May 19", () => {
		// May 2026 Tuesdays: 5, 12, 19, 26. After May 14, May 19 (3rd Tue) is still upcoming.
		const after = localDay(2026, 5, 14);
		const next = nextOccurrence(
			{
				kind: RecurrenceKind.Monthly,
				every: 1,
				dayOfWeek: { weekday: Weekday.Tue, ordinal: 3 },
			},
			after,
		);
		expect(next).toBe(localDay(2026, 5, 19));
	});

	it("third Tuesday rolls to next month when this month's is past — May 20 → June 16", () => {
		// June 2026's 3rd Tuesday is June 16.
		const after = localDay(2026, 5, 20);
		const next = nextOccurrence(
			{
				kind: RecurrenceKind.Monthly,
				every: 1,
				dayOfWeek: { weekday: Weekday.Tue, ordinal: 3 },
			},
			after,
		);
		expect(next).toBe(localDay(2026, 6, 16));
	});

	it("last Friday of this month when still in the future — May 14 → May 29", () => {
		// Last Friday of May 2026 is May 29.
		const after = localDay(2026, 5, 14);
		const next = nextOccurrence(
			{
				kind: RecurrenceKind.Monthly,
				every: 1,
				dayOfWeek: { weekday: Weekday.Fri, ordinal: -1 },
			},
			after,
		);
		expect(next).toBe(localDay(2026, 5, 29));
	});

	it("last Friday rolls to next month when this month's is past — May 30 → June 26", () => {
		// Last Friday of June 2026 is June 26.
		const after = localDay(2026, 5, 30);
		const next = nextOccurrence(
			{
				kind: RecurrenceKind.Monthly,
				every: 1,
				dayOfWeek: { weekday: Weekday.Fri, ordinal: -1 },
			},
			after,
		);
		expect(next).toBe(localDay(2026, 6, 26));
	});

	it("picks this month if the Nth weekday is still in the future", () => {
		// Asked on the 1st for the 3rd Tuesday of May 2026 → 2026-05-19.
		const after = localDay(2026, 5, 1);
		const next = nextOccurrence(
			{
				kind: RecurrenceKind.Monthly,
				every: 1,
				dayOfWeek: { weekday: Weekday.Tue, ordinal: 3 },
			},
			after,
		);
		expect(next).toBe(localDay(2026, 5, 19));
	});
});

describe("nextOccurrence — Yearly", () => {
	it("rolls to next year when after is past this year's occurrence", () => {
		const after = localDay(2026, 6, 1);
		const next = nextOccurrence({ kind: RecurrenceKind.Yearly, month: 2, day: 14 }, after);
		expect(next).toBe(localDay(2027, 2, 14));
	});

	it("stays in this year when after is before this year's occurrence", () => {
		const after = localDay(2026, 1, 1);
		const next = nextOccurrence({ kind: RecurrenceKind.Yearly, month: 2, day: 14 }, after);
		expect(next).toBe(localDay(2026, 2, 14));
	});

	it("Feb 29 clamps to Feb 28 in non-leap years", () => {
		// 2026 is not a leap year.
		const after = localDay(2026, 1, 1);
		const next = nextOccurrence({ kind: RecurrenceKind.Yearly, month: 2, day: 29 }, after);
		expect(next).toBe(localDay(2026, 2, 28));
	});
});

describe("nextOccurrence — Custom", () => {
	it("returns null for opaque RRULE (no in-tree parser)", () => {
		const after = localDay(2026, 5, 14);
		const next = nextOccurrence(
			{ kind: RecurrenceKind.Custom, rrule: "FREQ=DAILY;INTERVAL=3" },
			after,
		);
		expect(next).toBeNull();
	});
});
