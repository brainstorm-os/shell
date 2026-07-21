import { RecurrenceKind, Weekday, summarizeRecurrence } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { recurrenceLabels } from "./recurrence-labels";

const labels = recurrenceLabels();

describe("recurrenceLabels → summarizeRecurrence (calendar manifest)", () => {
	it("supplies every parametric label the keystone needs (no [?key] leaks)", () => {
		const phrases = [
			summarizeRecurrence({ kind: RecurrenceKind.Daily, every: 1 }, labels),
			summarizeRecurrence({ kind: RecurrenceKind.Daily, every: 4 }, labels),
			summarizeRecurrence(
				{ kind: RecurrenceKind.Weekly, every: 2, days: [Weekday.Mon, Weekday.Thu] },
				labels,
			),
			summarizeRecurrence({ kind: RecurrenceKind.Monthly, every: 1, dayOfMonth: 9 }, labels),
			summarizeRecurrence(
				{
					kind: RecurrenceKind.Monthly,
					every: 1,
					dayOfWeek: { weekday: Weekday.Tue, ordinal: -1 },
				},
				labels,
			),
			summarizeRecurrence({ kind: RecurrenceKind.Yearly, month: 3, day: 14 }, labels),
			summarizeRecurrence(null, labels),
		];
		for (const p of phrases) {
			expect(p).not.toContain("[?");
			expect(p).not.toContain("{");
			expect(p.length).toBeGreaterThan(0);
		}
	});

	it("renders the English manifest phrases", () => {
		expect(summarizeRecurrence({ kind: RecurrenceKind.Daily, every: 3 }, labels)).toBe(
			"Every 3 days",
		);
		expect(summarizeRecurrence({ kind: RecurrenceKind.Yearly, month: 7, day: 9 }, labels)).toBe(
			"Yearly on July 9",
		);
		expect(summarizeRecurrence(undefined, labels)).toBe("Does not repeat");
	});

	it("derives weekday names from the platform locale (non-empty, distinct)", () => {
		const wd = labels.weekdayShort;
		const all = [wd.mon, wd.tue, wd.wed, wd.thu, wd.fri, wd.sat, wd.sun];
		expect(new Set(all).size).toBe(7);
		expect(all.every((s) => s.length > 0)).toBe(true);
	});
});
