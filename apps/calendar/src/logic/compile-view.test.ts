import { RecurrenceKind } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { CalendarViewKind, WeekStartsOn } from "../types/calendar-view";
import {
	AgendaBucketKey,
	compileAgendaView,
	compileDayView,
	compileMonthView,
	compileWeekView,
} from "./compile-view";
import { EVENT_SOURCE_KEY, type ScheduledItem, sourceKeyFor } from "./scheduled-item";

function epoch(y: number, m: number, d: number, h = 0, min = 0): number {
	return new Date(y, m, d, h, min, 0, 0).getTime();
}

function makeItem(partial: Partial<ScheduledItem> & { id: string; start: number }): ScheduledItem {
	return {
		id: partial.id,
		sourceKey: partial.sourceKey ?? EVENT_SOURCE_KEY,
		sourceEntityId: partial.sourceEntityId ?? partial.id,
		title: partial.title ?? "Test",
		icon: partial.icon ?? null,
		start: partial.start,
		end: partial.end ?? null,
		allDay: partial.allDay ?? false,
		location: partial.location ?? null,
		recurrence: partial.recurrence ?? null,
		colorHint: partial.colorHint ?? null,
		...(partial.done !== undefined ? { done: partial.done } : {}),
	};
}

const NOW = epoch(2026, 4, 14, 13);

describe("compileMonthView", () => {
	const anchor = epoch(2026, 4, 14);
	const options = { anchor, weekStartsOn: WeekStartsOn.Monday, now: NOW };

	it("produces 42 cells in a 6×7 grid for May 2026", () => {
		const compiled = compileMonthView([], options);
		expect(compiled.kind).toBe(CalendarViewKind.Month);
		expect(compiled.cells).toHaveLength(42);
	});

	it("flags today + other-month + weekend correctly", () => {
		const compiled = compileMonthView([], options);
		const today = compiled.cells.find((c) => c.dayOfMonth === 14 && !c.isOtherMonth);
		expect(today?.isToday).toBe(true);
		const aprilCell = compiled.cells[0];
		expect(aprilCell?.isOtherMonth).toBe(true);
		const saturday = compiled.cells.find((c) => c.dayOfMonth === 16 && !c.isOtherMonth);
		expect(saturday?.isWeekend).toBe(true);
	});

	it("materializes a yearly recurrence (e.g. a birthday) into the visible month", () => {
		// Anchored years in the past; must still land on May 20 in the
		// May-2026 grid via the shared occurrence engine.
		const birthday = makeItem({
			id: "birthday:p1",
			sourceEntityId: "p1",
			start: epoch(2010, 4, 20),
			allDay: true,
			sourceKey: sourceKeyFor("brainstorm/Person/v1", "birthday"),
			recurrence: { kind: RecurrenceKind.Yearly, month: 5, day: 20 },
		});
		const compiled = compileMonthView([birthday], options);
		const may20 = compiled.cells.find((c) => c.dayOfMonth === 20 && !c.isOtherMonth);
		expect(may20?.allDayItems).toHaveLength(1);
		expect(may20?.allDayItems[0]?.sourceEntityId).toBe("p1");
		expect(may20?.allDayItems[0]?.id).toBe(`birthday:p1@${epoch(2026, 4, 20)}`);
		// Exactly one instance in a single-month window (not every year).
		const total = compiled.cells.reduce((n, c) => n + c.allDayItems.length, 0);
		expect(total).toBe(1);
	});

	it("buckets timed events into their day cell sorted by start", () => {
		const items: ScheduledItem[] = [
			makeItem({ id: "b", start: epoch(2026, 4, 14, 16) }),
			makeItem({ id: "a", start: epoch(2026, 4, 14, 10) }),
		];
		const compiled = compileMonthView(items, options);
		const today = compiled.cells.find((c) => c.dateKey === "2026-05-14");
		expect(today?.timedItems.map((i) => i.id)).toEqual(["a", "b"]);
	});

	it("multi-day events register in every day they span", () => {
		const items: ScheduledItem[] = [
			makeItem({
				id: "offsite",
				start: epoch(2026, 4, 11, 9),
				end: epoch(2026, 4, 13, 17),
			}),
		];
		const compiled = compileMonthView(items, options);
		const may11 = compiled.cells.find((c) => c.dateKey === "2026-05-11");
		const may12 = compiled.cells.find((c) => c.dateKey === "2026-05-12");
		const may13 = compiled.cells.find((c) => c.dateKey === "2026-05-13");
		expect(may11?.allDayItems.map((i) => i.id)).toContain("offsite");
		expect(may12?.allDayItems.map((i) => i.id)).toContain("offsite");
		expect(may13?.allDayItems.map((i) => i.id)).toContain("offsite");
	});

	it("all-day items go into the allDayItems bucket, not timedItems", () => {
		const items: ScheduledItem[] = [
			makeItem({ id: "focus", start: epoch(2026, 4, 18), allDay: true }),
		];
		const compiled = compileMonthView(items, options);
		const cell = compiled.cells.find((c) => c.dateKey === "2026-05-18");
		expect(cell?.allDayItems.map((i) => i.id)).toEqual(["focus"]);
		expect(cell?.timedItems).toEqual([]);
	});
});

describe("compileWeekView", () => {
	const anchor = epoch(2026, 4, 14); // Thursday
	const options = { anchor, weekStartsOn: WeekStartsOn.Monday, now: NOW };

	it("produces 7 day buckets ordered Mon → Sun", () => {
		const compiled = compileWeekView([], options);
		expect(compiled.kind).toBe(CalendarViewKind.Week);
		expect(compiled.days).toHaveLength(7);
		expect(new Date(compiled.days[0]?.dayStart ?? 0).getDay()).toBe(1);
		expect(new Date(compiled.days[6]?.dayStart ?? 0).getDay()).toBe(0);
	});

	it("buckets events into the correct day", () => {
		const items: ScheduledItem[] = [
			makeItem({ id: "lunch", start: epoch(2026, 4, 14, 13), end: epoch(2026, 4, 14, 14) }),
			makeItem({ id: "yoga", start: epoch(2026, 4, 15, 8), end: epoch(2026, 4, 15, 9) }),
		];
		const compiled = compileWeekView(items, options);
		const thu = compiled.days.find((d) => d.dateKey === "2026-05-14");
		const fri = compiled.days.find((d) => d.dateKey === "2026-05-15");
		expect(thu?.timedItems.map((i) => i.id)).toEqual(["lunch"]);
		expect(fri?.timedItems.map((i) => i.id)).toEqual(["yoga"]);
	});

	it("excludes events outside the week", () => {
		const items: ScheduledItem[] = [makeItem({ id: "next-week", start: epoch(2026, 4, 22, 12) })];
		const compiled = compileWeekView(items, options);
		const idsInWeek = compiled.days.flatMap((d) => [
			...d.allDayItems.map((i) => i.id),
			...d.timedItems.map((i) => i.id),
		]);
		expect(idsInWeek).not.toContain("next-week");
	});
});

describe("compileDayView", () => {
	const anchor = epoch(2026, 4, 14);
	const options = { anchor, weekStartsOn: WeekStartsOn.Monday, now: NOW };

	it("returns a single bucket marked as today", () => {
		const compiled = compileDayView([], options);
		expect(compiled.kind).toBe(CalendarViewKind.Day);
		expect(compiled.day.isToday).toBe(true);
	});

	it("filters items to the anchor day only", () => {
		const items: ScheduledItem[] = [
			makeItem({ id: "in", start: epoch(2026, 4, 14, 10) }),
			makeItem({ id: "out", start: epoch(2026, 4, 15, 10) }),
		];
		const compiled = compileDayView(items, options);
		expect(compiled.day.timedItems.map((i) => i.id)).toEqual(["in"]);
	});
});

describe("compileAgendaView", () => {
	const options = { anchor: NOW, weekStartsOn: WeekStartsOn.Monday, now: NOW };

	it("buckets items by Today / Tomorrow / This-week / Later", () => {
		const items: ScheduledItem[] = [
			makeItem({ id: "today", start: epoch(2026, 4, 14, 16) }),
			makeItem({ id: "tomorrow", start: epoch(2026, 4, 15, 10) }),
			makeItem({ id: "thisweek", start: epoch(2026, 4, 18, 10) }),
			makeItem({ id: "later", start: epoch(2026, 4, 28, 10) }),
		];
		const compiled = compileAgendaView(items, options);
		const byKey = new Map(compiled.buckets.map((b) => [b.key, b.items.map((i) => i.id)]));
		expect(byKey.get(AgendaBucketKey.Today)).toEqual(["today"]);
		expect(byKey.get(AgendaBucketKey.Tomorrow)).toEqual(["tomorrow"]);
		expect(byKey.get(AgendaBucketKey.ThisWeek)).toEqual(["thisweek"]);
		expect(byKey.get(AgendaBucketKey.Later)).toEqual(["later"]);
	});

	it("drops completed (done) items from the upcoming agenda (F-028)", () => {
		const items: ScheduledItem[] = [
			makeItem({ id: "open", start: epoch(2026, 4, 18, 10) }),
			makeItem({ id: "done", start: epoch(2026, 4, 18, 11), done: true }),
		];
		const compiled = compileAgendaView(items, options);
		const ids = compiled.buckets.flatMap((b) => b.items.map((i) => i.id));
		expect(ids).toContain("open");
		expect(ids).not.toContain("done");
	});

	it("drops past items entirely (before today)", () => {
		const items: ScheduledItem[] = [
			makeItem({ id: "past", start: epoch(2026, 4, 10, 10) }),
			makeItem({ id: "today", start: epoch(2026, 4, 14, 16) }),
		];
		const compiled = compileAgendaView(items, options);
		const ids = compiled.buckets.flatMap((b) => b.items.map((i) => i.id));
		expect(ids).not.toContain("past");
		expect(ids).toContain("today");
	});

	it("keeps ongoing items (started before today, ending later) under Today", () => {
		const items: ScheduledItem[] = [
			makeItem({
				id: "ongoing",
				start: epoch(2026, 4, 11, 9),
				end: epoch(2026, 4, 16, 17),
			}),
		];
		const compiled = compileAgendaView(items, options);
		const today = compiled.buckets.find((b) => b.key === AgendaBucketKey.Today);
		expect(today?.items.map((i) => i.id)).toContain("ongoing");
	});

	it("omits empty buckets", () => {
		const items: ScheduledItem[] = [makeItem({ id: "today", start: epoch(2026, 4, 14, 16) })];
		const compiled = compileAgendaView(items, options);
		expect(compiled.buckets.map((b) => b.key)).toEqual([AgendaBucketKey.Today]);
	});

	it("sorts items within a bucket by start ascending", () => {
		const items: ScheduledItem[] = [
			makeItem({ id: "later-today", start: epoch(2026, 4, 14, 18) }),
			makeItem({ id: "earlier-today", start: epoch(2026, 4, 14, 14) }),
		];
		const compiled = compileAgendaView(items, options);
		const today = compiled.buckets.find((b) => b.key === AgendaBucketKey.Today);
		expect(today?.items.map((i) => i.id)).toEqual(["earlier-today", "later-today"]);
	});
});
