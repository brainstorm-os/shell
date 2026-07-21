import { RecurrenceKind, Weekday } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { recurrenceToRRule, rruleToRecurrence, stripRRulePrefix } from "./rrule";

describe("recurrenceToRRule", () => {
	it("serializes each structured kind", () => {
		expect(recurrenceToRRule({ kind: RecurrenceKind.Daily, every: 1 })).toBe("FREQ=DAILY");
		expect(recurrenceToRRule({ kind: RecurrenceKind.Daily, every: 3 })).toBe("FREQ=DAILY;INTERVAL=3");
		expect(
			recurrenceToRRule({ kind: RecurrenceKind.Weekly, every: 2, days: [Weekday.Mon, Weekday.Wed] }),
		).toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE");
		expect(recurrenceToRRule({ kind: RecurrenceKind.Monthly, every: 1, dayOfMonth: 15 })).toBe(
			"FREQ=MONTHLY;BYMONTHDAY=15",
		);
		expect(
			recurrenceToRRule({
				kind: RecurrenceKind.Monthly,
				every: 1,
				dayOfWeek: { weekday: Weekday.Tue, ordinal: 2 },
			}),
		).toBe("FREQ=MONTHLY;BYDAY=2TU");
		expect(recurrenceToRRule({ kind: RecurrenceKind.Yearly, month: 3, day: 14 })).toBe(
			"FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=14",
		);
		expect(recurrenceToRRule({ kind: RecurrenceKind.Custom, rrule: "FREQ=HOURLY" })).toBe(
			"FREQ=HOURLY",
		);
	});
});

describe("rruleToRecurrence", () => {
	it("round-trips every structured kind", () => {
		const rules = [
			{ kind: RecurrenceKind.Daily, every: 4 },
			{ kind: RecurrenceKind.Weekly, every: 1, days: [Weekday.Mon, Weekday.Fri] },
			{ kind: RecurrenceKind.Monthly, every: 2, dayOfMonth: 9 },
			{ kind: RecurrenceKind.Monthly, every: 1, dayOfWeek: { weekday: Weekday.Fri, ordinal: -1 } },
			{ kind: RecurrenceKind.Yearly, month: 12, day: 25 },
		] as const;
		for (const rec of rules) {
			expect(rruleToRecurrence(recurrenceToRRule(rec))).toEqual(rec);
		}
	});

	it("falls back to Custom for an unrecognised but non-empty rule", () => {
		expect(rruleToRecurrence("FREQ=HOURLY;INTERVAL=6")).toEqual({
			kind: RecurrenceKind.Custom,
			rrule: "FREQ=HOURLY;INTERVAL=6",
		});
	});

	it("returns null for an empty rule and strips the RRULE: prefix", () => {
		expect(rruleToRecurrence("")).toBeNull();
		expect(stripRRulePrefix("RRULE:FREQ=DAILY")).toBe("FREQ=DAILY");
		expect(rruleToRecurrence("RRULE:FREQ=DAILY")).toEqual({ kind: RecurrenceKind.Daily, every: 1 });
	});
});
