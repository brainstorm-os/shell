import { describe, expect, it } from "vitest";
import type { Event } from "../types/event";
import { bulkShiftByDays, bulkShiftToDate } from "./bulk-reschedule";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const NOW = 9_999;

function ev(id: string, start: number, end: number | null): Event {
	return {
		id,
		title: id,
		icon: null,
		start,
		end,
		allDay: false,
		location: null,
		recurrence: null,
		statusKey: null,
		colorHint: null,
		reminders: [],
		attendees: [],
		timeZone: null,
		createdAt: 1,
		updatedAt: 1,
	};
}

const d10 = new Date(2026, 4, 10, 9, 0).getTime();
const d12 = new Date(2026, 4, 12, 14, 0).getTime();

describe("bulkShiftToDate", () => {
	it("moves the batch so its earliest event lands on the target day, keeping spacing + times", () => {
		const target = new Date(2026, 4, 20, 0, 0).getTime();
		const out = bulkShiftToDate([ev("a", d10, d10 + HOUR), ev("b", d12, d12 + HOUR)], target, NOW);

		// Earliest (d10, May 10) → May 20: +10 days. Both shift by the same delta.
		expect(out[0]?.start).toBe(d10 + 10 * DAY);
		expect(out[1]?.start).toBe(d12 + 10 * DAY);
		// Time-of-day preserved.
		expect(new Date(out[0]?.start ?? Number.NaN).getHours()).toBe(9);
		expect(new Date(out[1]?.start ?? Number.NaN).getHours()).toBe(14);
		// End shifts with start; updatedAt stamped.
		expect(out[0]?.end).toBe(d10 + HOUR + 10 * DAY);
		expect(out[0]?.updatedAt).toBe(NOW);
	});

	it("is a no-op delta when already on the target day (returns clones)", () => {
		const target = new Date(2026, 4, 10, 0, 0).getTime();
		const input = [ev("a", d10, null)];
		const out = bulkShiftToDate(input, target, NOW);
		expect(out[0]?.start).toBe(d10);
		expect(out[0]).not.toBe(input[0]);
	});

	it("returns [] for an empty batch", () => {
		expect(bulkShiftToDate([], NOW, NOW)).toEqual([]);
	});

	it("excludes locked events — they neither move nor anchor the batch", () => {
		const target = new Date(2026, 4, 20, 0, 0).getTime();
		const lockedEarliest = { ...ev("locked", d10, d10 + HOUR), locked: true };
		const out = bulkShiftToDate([lockedEarliest, ev("b", d12, d12 + HOUR)], target, NOW);
		// The locked event is dropped from the output (never saved), and the
		// delta anchors on the earliest MOVABLE event (d12, May 12 → May 20: +8d).
		expect(out).toHaveLength(1);
		expect(out[0]?.id).toBe("b");
		expect(out[0]?.start).toBe(d12 + 8 * DAY);
	});

	it("returns [] when every selected event is locked", () => {
		const target = new Date(2026, 4, 20, 0, 0).getTime();
		expect(bulkShiftToDate([{ ...ev("a", d10, null), locked: true }], target, NOW)).toEqual([]);
	});
});

describe("bulkShiftByDays", () => {
	it("nudges every event by the day delta", () => {
		const out = bulkShiftByDays([ev("a", d10, d10 + HOUR)], -3, NOW);
		expect(out[0]?.start).toBe(d10 - 3 * DAY);
		expect(out[0]?.end).toBe(d10 + HOUR - 3 * DAY);
	});

	it("keeps an instant event's null end", () => {
		const out = bulkShiftByDays([ev("a", d10, null)], 2, NOW);
		expect(out[0]?.end).toBeNull();
	});

	it("excludes locked events from the nudge", () => {
		const out = bulkShiftByDays(
			[{ ...ev("a", d10, null), locked: true }, ev("b", d12, null)],
			2,
			NOW,
		);
		expect(out).toHaveLength(1);
		expect(out[0]?.id).toBe("b");
	});
});
