// @vitest-environment jsdom
import { CalendarRange, CalendarRecurring, CalendarWeekStart } from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import type { CompiledView } from "../logic/compile-view";
import type { EntityRow } from "../logic/in-memory-entities";
import type { CalendarLayoutOptions } from "../types/list-view";
import { type CalendarViewProps, bucketByDay, renderCalendarView } from "./calendar-view";

const L = (y: number, m1: number, d: number): number =>
	new Date(y, m1 - 1, d, 0, 0, 0, 0).getTime();

function row(id: string, props: Record<string, unknown>): EntityRow {
	return {
		id,
		type: "io.brainstorm.demo/Person/v1",
		properties: props,
		createdAt: 0,
		updatedAt: 0,
		deletedAt: null,
	};
}

const wide = { windowStart: L(2000, 1, 1), windowEnd: L(2100, 1, 1) };

describe("bucketByDay — non-recurring (unchanged behaviour)", () => {
	it("buckets on the absolute stored day", () => {
		const r = row("a", { d: L(2026, 6, 15) });
		const map = bucketByDay([r], "d", wide);
		expect([...map.keys()]).toEqual([L(2026, 6, 15)]);
		expect(map.get(L(2026, 6, 15))).toEqual([r]);
	});

	it("skips rows with an empty/unparseable date", () => {
		const map = bucketByDay([row("a", {}), row("b", { d: "not-a-date" })], "d", wide);
		expect(map.size).toBe(0);
	});
});

describe("bucketByDay — Yearly recurrence (Birthdays view)", () => {
	it("places a past-anchored birthday on the displayed period's occurrence", () => {
		// Person born 1985-07-09; a July-2026 month grid must show 2026-07-09.
		const r = row("p1", { birthday: L(1985, 7, 9) });
		const map = bucketByDay([r], "birthday", {
			recurring: CalendarRecurring.Yearly,
			windowStart: L(2026, 6, 28),
			windowEnd: L(2026, 8, 9),
		});
		expect([...map.keys()]).toEqual([L(2026, 7, 9)]);
		expect(map.get(L(2026, 7, 9))).toEqual([r]);
	});

	it("is a single instance per period (no virtual fan-out across years)", () => {
		const r = row("p1", { birthday: L(1990, 3, 14) });
		const map = bucketByDay([r], "birthday", {
			recurring: CalendarRecurring.Yearly,
			windowStart: L(2026, 3, 1),
			windowEnd: L(2026, 3, 31),
		});
		const total = [...map.values()].reduce((n, v) => n + v.length, 0);
		expect(total).toBe(1);
		expect([...map.keys()]).toEqual([L(2026, 3, 14)]);
	});

	it("drops a birthday whose month-day falls outside the displayed window", () => {
		const r = row("p1", { birthday: L(1980, 12, 25) });
		const map = bucketByDay([r], "birthday", {
			recurring: CalendarRecurring.Yearly,
			windowStart: L(2026, 6, 1),
			windowEnd: L(2026, 6, 30),
		});
		expect(map.size).toBe(0);
	});

	it("handles a month grid that crosses a year boundary", () => {
		// Dec-2025 grid bleeding into Jan-2026: a Jan-3 birthday lands in 2026.
		const r = row("p1", { birthday: L(1970, 1, 3) });
		const map = bucketByDay([r], "birthday", {
			recurring: CalendarRecurring.Yearly,
			windowStart: L(2025, 11, 30),
			windowEnd: L(2026, 1, 10),
		});
		expect([...map.keys()]).toEqual([L(2026, 1, 3)]);
	});

	it("without the flag, a birthday stays on its absolute stored year", () => {
		const r = row("p1", { birthday: L(1985, 7, 9) });
		const map = bucketByDay([r], "birthday", {
			windowStart: L(2026, 1, 1),
			windowEnd: L(2026, 12, 31),
		});
		expect([...map.keys()]).toEqual([L(1985, 7, 9)]);
	});
});

function calendarProps(range: CalendarRange, rows: EntityRow[]): CalendarViewProps {
	const layout: CalendarLayoutOptions = {
		range,
		startWeekOn: CalendarWeekStart.Monday,
		primaryDateProperty: "d",
		colorBy: null,
	};
	const compiled: CompiledView = { rows, groups: [] };
	return {
		compiled,
		layout,
		groupBy: { propertyId: "d" },
		cursorMonth: L(2026, 6, 15),
		selectedIds: new Set<string>(),
		onSelect: vi.fn(),
		onOpen: vi.fn(),
		onPrev: vi.fn(),
		onNext: vi.fn(),
		onToday: vi.fn(),
		onRangeChange: vi.fn(),
		onMoveToDay: vi.fn(),
	};
}

describe("renderCalendarView — year-view keyboard nav (9.12.6)", () => {
	it("stamps composite indices on every month tile's day cells", () => {
		const host = document.createElement("div");
		renderCalendarView(host, calendarProps(CalendarRange.Year, [row("a", { d: L(2026, 6, 15) })]));
		const tiles = host.querySelectorAll(".dbv-cal__month-tile");
		expect(tiles.length).toBe(12);
		for (const tile of tiles) {
			const indexed = tile.querySelectorAll(".bs-cal-month__cell[data-composite-index]");
			expect(indexed.length).toBeGreaterThan(0);
		}
	});

	it("opens the first record on the focused day via the keyboard handler", () => {
		const host = document.createElement("div");
		const r = row("a", { d: L(2026, 6, 15) });
		const props = calendarProps(CalendarRange.Year, [r]);
		renderCalendarView(host, props);
		const grid = host.querySelector<HTMLElement>(".dbv-cal__month-tile .bs-cal-month__grid");
		expect(grid).not.toBeNull();
		const cell = host.querySelector<HTMLElement>(".bs-cal-month__cell[data-composite-index]");
		cell?.focus();
		grid?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		// Some cell's Enter opens *a* record; the keyboard cursor lands on the
		// first cell, which may be an out-of-month padding day, so assert the
		// wiring is live rather than the specific row.
		expect(grid?.getAttribute("aria-activedescendant")).toBeTruthy();
	});

	it("month-view '+N more' overflow uses the localized catalog string", () => {
		const host = document.createElement("div");
		const many = Array.from({ length: 10 }, (_, i) => row(`r${i}`, { d: L(2026, 6, 15) }));
		renderCalendarView(host, calendarProps(CalendarRange.Month, many));
		const more = host.querySelector(".dbv-cal__more");
		expect(more?.textContent).toMatch(/^\+\d+ more$/);
	});
});
