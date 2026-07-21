import { DEFAULT_RECURRENCE_LABELS, RecurrenceKind, Weekday } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	RepeatKind,
	clampInterval,
	coerceRecurrence,
	defaultRecurrenceForKind,
	normalizeWeekdays,
	recurrenceCaption,
	repeatKindOf,
	weekdayForDate,
} from "./recurrence-edit";

// 2024-01-03 is a Wednesday (local), 2024-03-14 a Thursday.
const WED = new Date(2024, 0, 3, 9, 0).getTime();
const SUN = new Date(2024, 0, 7, 9, 0).getTime();

describe("recurrence-edit", () => {
	it("maps a JS date to the ISO Weekday enum", () => {
		expect(weekdayForDate(WED)).toBe(Weekday.Wed);
		expect(weekdayForDate(SUN)).toBe(Weekday.Sun);
	});

	it("round-trips repeatKindOf for every kind", () => {
		expect(repeatKindOf(null)).toBe(RepeatKind.None);
		expect(repeatKindOf({ kind: RecurrenceKind.Daily, every: 1 })).toBe(RepeatKind.Daily);
		expect(repeatKindOf({ kind: RecurrenceKind.Custom, rrule: "FREQ=DAILY" })).toBe(
			RepeatKind.Custom,
		);
	});

	it("seeds each kind's default from the start instant", () => {
		expect(defaultRecurrenceForKind(RepeatKind.None, WED)).toBeNull();
		expect(defaultRecurrenceForKind(RepeatKind.Daily, WED)).toEqual({
			kind: RecurrenceKind.Daily,
			every: 1,
		});
		expect(defaultRecurrenceForKind(RepeatKind.Weekly, WED)).toEqual({
			kind: RecurrenceKind.Weekly,
			every: 1,
			days: [Weekday.Wed],
		});
		expect(defaultRecurrenceForKind(RepeatKind.Monthly, WED)).toEqual({
			kind: RecurrenceKind.Monthly,
			every: 1,
			dayOfMonth: 3,
		});
		expect(defaultRecurrenceForKind(RepeatKind.Yearly, WED)).toEqual({
			kind: RecurrenceKind.Yearly,
			month: 1,
			day: 3,
		});
		const custom = defaultRecurrenceForKind(RepeatKind.Custom, WED);
		expect(custom?.kind).toBe(RecurrenceKind.Custom);
	});

	it("every default is structurally valid (coerceRecurrence keeps it)", () => {
		for (const kind of [
			RepeatKind.Daily,
			RepeatKind.Weekly,
			RepeatKind.Monthly,
			RepeatKind.Yearly,
			RepeatKind.Custom,
		]) {
			const rec = defaultRecurrenceForKind(kind, WED);
			expect(coerceRecurrence(rec)).toEqual(rec);
		}
	});

	it("clamps the interval to an integer ≥ 1", () => {
		expect(clampInterval(0)).toBe(1);
		expect(clampInterval(-4)).toBe(1);
		expect(clampInterval(3.9)).toBe(3);
		expect(clampInterval(Number.NaN)).toBe(1);
	});

	it("normalizes weekdays to ISO order, deduped, never empty", () => {
		expect(normalizeWeekdays([Weekday.Fri, Weekday.Mon, Weekday.Mon], Weekday.Sun)).toEqual([
			Weekday.Mon,
			Weekday.Fri,
		]);
		expect(normalizeWeekdays([], Weekday.Thu)).toEqual([Weekday.Thu]);
	});

	it("coerces a malformed recurrence to null", () => {
		expect(coerceRecurrence({ kind: RecurrenceKind.Custom, rrule: "" })).toBeNull();
		expect(coerceRecurrence(null)).toBeNull();
	});
});

describe("recurrenceCaption (F-153)", () => {
	it("hides the caption for the no-repeat default", () => {
		expect(recurrenceCaption(null, "Does not repeat", DEFAULT_RECURRENCE_LABELS)).toBeNull();
	});

	it("hides the caption when the summary equals the selected kind label", () => {
		expect(
			recurrenceCaption({ kind: RecurrenceKind.Daily, every: 1 }, "Every day", {
				...DEFAULT_RECURRENCE_LABELS,
			}),
		).toBeNull();
	});

	it("renders the resolved rule when it adds information", () => {
		expect(
			recurrenceCaption(
				{ kind: RecurrenceKind.Weekly, every: 1, days: [Weekday.Mon] },
				"Weekly",
				DEFAULT_RECURRENCE_LABELS,
			),
		).toBe("Weekly on Mon");
		expect(
			recurrenceCaption({ kind: RecurrenceKind.Daily, every: 3 }, "Daily", {
				...DEFAULT_RECURRENCE_LABELS,
			}),
		).toBe("Every 3 days");
	});

	it("hides the caption for a malformed value (degrades to the none label)", () => {
		expect(
			recurrenceCaption(
				{ kind: "bogus" } as unknown as Parameters<typeof recurrenceCaption>[0],
				"Daily",
				DEFAULT_RECURRENCE_LABELS,
			),
		).toBeNull();
	});
});
