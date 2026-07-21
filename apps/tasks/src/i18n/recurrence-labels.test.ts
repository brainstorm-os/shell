import { RecurrenceKind, Weekday, summarizeRecurrence } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { recurrenceLabels } from "./recurrence-labels";

const labels = recurrenceLabels();

describe("tasks recurrenceLabels → summarizeRecurrence (tasks manifest)", () => {
	it("supplies every parametric label the keystone needs (no [?key]/{param} leaks)", () => {
		const phrases = [
			summarizeRecurrence({ kind: RecurrenceKind.Daily, every: 1 }, labels),
			summarizeRecurrence({ kind: RecurrenceKind.Daily, every: 2 }, labels),
			summarizeRecurrence({ kind: RecurrenceKind.Weekly, every: 1, days: [Weekday.Sun] }, labels),
			summarizeRecurrence(
				{ kind: RecurrenceKind.Weekly, every: 3, days: [Weekday.Mon, Weekday.Fri] },
				labels,
			),
			summarizeRecurrence({ kind: RecurrenceKind.Monthly, every: 2, dayOfMonth: 1 }, labels),
			summarizeRecurrence(
				{
					kind: RecurrenceKind.Monthly,
					every: 1,
					dayOfWeek: { weekday: Weekday.Wed, ordinal: 2 },
				},
				labels,
			),
			summarizeRecurrence({ kind: RecurrenceKind.Yearly, month: 12, day: 25 }, labels),
			summarizeRecurrence({ kind: RecurrenceKind.Custom, rrule: "FREQ=HOURLY" }, labels),
			summarizeRecurrence(null, labels),
		];
		for (const p of phrases) {
			expect(p).not.toContain("[?");
			expect(p).not.toContain("{");
			expect(p.length).toBeGreaterThan(0);
		}
	});

	it("renders the English manifest phrases", () => {
		expect(
			summarizeRecurrence({ kind: RecurrenceKind.Weekly, every: 1, days: [Weekday.Sun] }, labels),
		).toBe("Weekly on Sun");
		expect(summarizeRecurrence({ kind: RecurrenceKind.Daily, every: 2 }, labels)).toBe(
			"Every 2 days",
		);
		expect(summarizeRecurrence(null, labels)).toBe("Does not repeat");
	});

	it("derives weekday names from the platform locale (non-empty, distinct)", () => {
		const wd = labels.weekdayShort;
		const all = [wd.mon, wd.tue, wd.wed, wd.thu, wd.fri, wd.sat, wd.sun];
		expect(new Set(all).size).toBe(7);
		expect(all.every((s) => s.length > 0)).toBe(true);
	});
});
