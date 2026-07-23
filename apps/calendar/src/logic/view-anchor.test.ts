import { describe, expect, it } from "vitest";
import { CalendarViewKind, WeekStartsOn } from "../types/calendar-view";
import { viewSwitchAnchor } from "./view-anchor";

// A mid-month, mid-day instant: Thu 23 July 2026, 14:37 local.
const JULY_23 = new Date(2026, 6, 23, 14, 37, 12).getTime();

describe("viewSwitchAnchor", () => {
	it("keeps the FULL anchor when switching to Year — the month is not lost (912/912b regression)", () => {
		const next = viewSwitchAnchor(CalendarViewKind.Year, JULY_23, WeekStartsOn.Monday);
		expect(next).toBe(JULY_23);
		// The old bug collapsed to Jan 1; guard against a regression to it.
		expect(new Date(next).getMonth()).toBe(6); // still July, not January
	});

	it("Year → Month round-trips to the same month, not January", () => {
		const yearAnchor = viewSwitchAnchor(CalendarViewKind.Year, JULY_23, WeekStartsOn.Monday);
		const monthAnchor = viewSwitchAnchor(CalendarViewKind.Month, yearAnchor, WeekStartsOn.Monday);
		expect(new Date(monthAnchor).getMonth()).toBe(6); // July, was landing on January (0)
		expect(new Date(monthAnchor).getFullYear()).toBe(2026);
	});

	it("Month and Agenda keep the anchor as-is", () => {
		expect(viewSwitchAnchor(CalendarViewKind.Month, JULY_23, WeekStartsOn.Monday)).toBe(JULY_23);
		expect(viewSwitchAnchor(CalendarViewKind.Agenda, JULY_23, WeekStartsOn.Monday)).toBe(JULY_23);
	});

	it("Day snaps to the start of the day", () => {
		const next = viewSwitchAnchor(CalendarViewKind.Day, JULY_23, WeekStartsOn.Monday);
		const d = new Date(next);
		expect([d.getHours(), d.getMinutes(), d.getSeconds()]).toEqual([0, 0, 0]);
		expect(d.getDate()).toBe(23);
	});

	it("Week snaps to the week start (Monday) for a Thursday anchor", () => {
		const next = viewSwitchAnchor(CalendarViewKind.Week, JULY_23, WeekStartsOn.Monday);
		const d = new Date(next);
		expect(d.getDay()).toBe(1); // Monday
		expect(d.getDate()).toBe(20); // Mon 20 July 2026
	});
});
