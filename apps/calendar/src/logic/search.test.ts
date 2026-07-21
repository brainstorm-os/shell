import { RecurrenceKind, Weekday } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { EVENT_SOURCE_KEY, type ScheduledItem } from "./scheduled-item";
import { matchScore, searchScheduledItems } from "./search";

const NOW = new Date(2026, 4, 14, 12, 0, 0).getTime();
const DAY = 86_400_000;

function item(
	id: string,
	title: string,
	start: number,
	over: Partial<ScheduledItem> = {},
): ScheduledItem {
	return {
		id,
		sourceKey: EVENT_SOURCE_KEY,
		sourceEntityId: id,
		title,
		icon: null,
		start,
		end: null,
		allDay: false,
		location: null,
		recurrence: null,
		colorHint: null,
		...over,
	};
}

describe("matchScore", () => {
	it("ranks title-prefix over substring over location", () => {
		expect(matchScore(item("a", "Standup", NOW), "stand")).toBe(3);
		expect(matchScore(item("b", "Daily Standup", NOW), "stand")).toBe(2);
		expect(matchScore(item("c", "Lunch", NOW, { location: "Standby Café" }), "standby")).toBe(1);
		expect(matchScore(item("d", "Lunch", NOW), "zzz")).toBe(0);
	});
});

describe("searchScheduledItems", () => {
	it("returns [] for a blank query", () => {
		expect(searchScheduledItems([item("a", "Standup", NOW)], "  ", { now: NOW })).toEqual([]);
	});

	it("filters by keyword and ranks prefix matches first", () => {
		const items = [
			item("a", "Team review", NOW + DAY),
			item("b", "Review notes", NOW + 2 * DAY),
			item("c", "Lunch", NOW + DAY),
		];
		const results = searchScheduledItems(items, "review", { now: NOW });
		expect(results.map((r) => r.id)).toEqual(["b", "a"]);
	});

	it("prefers upcoming occurrences and dedupes recurring events to one row", () => {
		const recurring = item("r", "Weekly sync", NOW - 30 * DAY, {
			recurrence: { kind: RecurrenceKind.Weekly, every: 1, days: [Weekday.Thu] },
		});
		const results = searchScheduledItems([recurring], "sync", { now: NOW });
		expect(results).toHaveLength(1);
		// The chosen occurrence is at/after now (upcoming preferred).
		expect(results[0]?.start).toBeGreaterThanOrEqual(NOW - DAY);
	});

	it("caps the result count", () => {
		const items = Array.from({ length: 80 }, (_, i) =>
			item(`e${i}`, `Meeting ${i}`, NOW + i * 3600_000),
		);
		expect(searchScheduledItems(items, "meeting", { now: NOW, limit: 25 })).toHaveLength(25);
	});
});
