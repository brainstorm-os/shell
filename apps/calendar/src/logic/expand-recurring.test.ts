import { RecurrenceKind, yearlyRecurrenceForDate } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { expandRecurringItems } from "./expand-recurring";
import { EVENT_SOURCE_KEY, type ScheduledItem } from "./scheduled-item";

const L = (y: number, m1: number, d: number, h = 0): number =>
	new Date(y, m1 - 1, d, h, 0, 0, 0).getTime();

function item(over: Partial<ScheduledItem> & Pick<ScheduledItem, "id" | "start">): ScheduledItem {
	return {
		sourceKey: EVENT_SOURCE_KEY,
		sourceEntityId: over.id,
		title: "x",
		icon: null,
		end: null,
		allDay: false,
		location: null,
		recurrence: null,
		colorHint: null,
		...over,
	};
}

describe("expandRecurringItems", () => {
	it("passes non-recurring items through unchanged (same identity)", () => {
		const a = item({ id: "a", start: L(2026, 6, 1) });
		const out = expandRecurringItems([a], L(2026, 6, 1), L(2026, 6, 30));
		expect(out).toEqual([a]);
		expect(out[0]).toBe(a);
	});

	it("materializes a yearly birthday into one instance per year in the window", () => {
		const bday = L(1985, 7, 9);
		const out = expandRecurringItems(
			[
				item({
					id: "birthday:p1",
					sourceEntityId: "p1",
					start: bday,
					allDay: true,
					recurrence: yearlyRecurrenceForDate(bday) ?? null,
				}),
			],
			L(2025, 1, 1),
			L(2026, 12, 31),
		);
		expect(out.map((i) => i.start)).toEqual([L(2025, 7, 9), L(2026, 7, 9)]);
		// Stable per-occurrence id; source entity preserved for intent.open.
		expect(out.map((i) => i.id)).toEqual([
			`birthday:p1@${L(2025, 7, 9)}`,
			`birthday:p1@${L(2026, 7, 9)}`,
		]);
		expect(out.every((i) => i.sourceEntityId === "p1")).toBe(true);
		// Recurrence is kept on the instance (chip badge + summary); the
		// instance is flagged so it's never re-expanded.
		expect(out.every((i) => i.recurrence !== null)).toBe(true);
		expect(out.every((i) => i.isRecurringInstance === true)).toBe(true);
		expect(out.every((i) => i.allDay)).toBe(true);
	});

	it("is idempotent — a second pass never re-fans materialized instances", () => {
		const src = item({
			id: "ev",
			start: L(2026, 1, 1),
			recurrence: { kind: RecurrenceKind.Daily, every: 1 },
		});
		const once = expandRecurringItems([src], L(2026, 1, 1), L(2026, 1, 4));
		const twice = expandRecurringItems(once, L(2026, 1, 1), L(2026, 1, 4));
		expect(twice).toEqual(once);
	});

	it("preserves the item's duration across every instance", () => {
		const start = L(2026, 1, 5, 9);
		const out = expandRecurringItems(
			[
				item({
					id: "ev",
					start,
					end: start + 90 * 60_000,
					recurrence: { kind: RecurrenceKind.Daily, every: 1 },
				}),
			],
			L(2026, 1, 5),
			L(2026, 1, 8),
		);
		expect(out).toHaveLength(3);
		for (const i of out) {
			expect(i.end).not.toBeNull();
			expect((i.end as number) - i.start).toBe(90 * 60_000);
		}
	});

	it("drops a recurring item with no occurrence in the window", () => {
		const out = expandRecurringItems(
			[
				item({
					id: "ev",
					start: L(2026, 3, 1),
					recurrence: { kind: RecurrenceKind.Yearly, month: 3, day: 1 },
				}),
			],
			L(2030, 1, 1),
			L(2030, 1, 31),
		);
		expect(out).toEqual([]);
	});
});
