// @vitest-environment jsdom
import {
	CROSS_APP_DROP_EVENT,
	DragPayloadKind,
	type DropDelivery,
	DropEffect,
	type ObjectDragPayload,
} from "@brainstorm-os/sdk-types";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompiledMonthView, MonthDayCell } from "../../logic/compile-view";
import { EVENT_SOURCE_KEY, type ScheduledItem } from "../../logic/scheduled-item";
import { flush, renderInto } from "../../test/render";
import { CalendarViewKind, WeekStartsOn } from "../../types/calendar-view";
import { MonthView } from "./month-view";
import type { ViewCallbacks } from "./view-callbacks";

function makeItem(id: string, over: Partial<ScheduledItem> = {}): ScheduledItem {
	const now = 1_700_000_000_000;
	return {
		id,
		sourceKey: EVENT_SOURCE_KEY,
		sourceEntityId: id,
		title: `Event ${id}`,
		icon: null,
		start: now,
		end: now + 3_600_000,
		allDay: false,
		location: null,
		recurrence: null,
		colorHint: null,
		...over,
	};
}

function makeCell(
	dayStart: number,
	dayOfMonth: number,
	over: Partial<MonthDayCell> = {},
): MonthDayCell {
	return {
		dayStart,
		dateKey: String(dayStart),
		dayOfMonth,
		isOtherMonth: false,
		isToday: false,
		isWeekend: false,
		allDayItems: [],
		timedItems: [],
		...over,
	};
}

type MonthCb = Pick<
	ViewCallbacks,
	"onItemClick" | "onDayClick" | "onEmptyCellClick" | "objectMenu" | "onReschedule" | "onDropObject"
>;
function cbs(over: Partial<MonthCb> = {}): MonthCb {
	return {
		onItemClick: vi.fn(),
		onDayClick: vi.fn(),
		onEmptyCellClick: vi.fn(),
		objectMenu: vi.fn(() => null),
		onReschedule: vi.fn(),
		...over,
	};
}

let handle: Awaited<ReturnType<typeof renderInto>> | null = null;
afterEach(async () => {
	await handle?.unmount();
	handle = null;
	document.body.replaceChildren();
});

describe("month-view multi-day ribbons", () => {
	it("paints a spanning event as connected ribbon segments with one title", async () => {
		const DAY = 86_400_000;
		const base = 1_700_000_000_000;
		const span = makeItem("span-1", { title: "Offsite", start: base, end: base + 2 * DAY });
		const cells: MonthDayCell[] = Array.from({ length: 42 }, (_, i) =>
			[2, 3, 4].includes(i) ? makeCell(i, i + 1, { allDayItems: [span] }) : makeCell(i, (i % 31) + 1),
		);
		const compiled: CompiledMonthView = {
			kind: CalendarViewKind.Month,
			rangeStart: 0,
			rangeEnd: 0,
			cells,
		};
		const onItemClick = vi.fn();
		handle = await renderInto(
			<MonthView
				compiled={compiled}
				weekStartsOn={WeekStartsOn.Monday}
				callbacks={cbs({ onItemClick })}
			/>,
		);
		const root = handle.container;
		const ribbons = root.querySelectorAll(".cal-month__ribbon");
		expect(ribbons.length).toBe(3);
		const titled = root.querySelectorAll(".cal-month__ribbon-title");
		expect(titled.length).toBe(1);
		expect(titled[0]?.textContent).toBe("Offsite");

		root.querySelector<HTMLButtonElement>(".cal-month__ribbon")?.click();
		expect(onItemClick).toHaveBeenCalledWith(span);

		// The span is NOT also repeated as a chip in the cells.
		expect(root.querySelector(".cal-month__item")).toBeNull();
	});

	// F-316 regression: cell content was paired to compiled cells via a
	// call-order counter reset in MonthView's render body. StrictMode (how
	// main.tsx mounts the app) double-invokes the child MonthGrid render,
	// so the second pass read counter positions 42..83 → every cell got
	// `undefined` and the whole month rendered with NO events/ribbons.
	it("renders ribbons and chips under StrictMode (double-render safe)", async () => {
		const DAY = 86_400_000;
		const base = 1_700_000_000_000;
		const span = makeItem("span-1", { title: "Offsite", start: base, end: base + 2 * DAY });
		const timed = makeItem("timed-1", { title: "Standup" });
		const cells: MonthDayCell[] = Array.from({ length: 42 }, (_, i) => {
			if ([2, 3, 4].includes(i)) return makeCell(i, i + 1, { allDayItems: [span] });
			if (i === 9) return makeCell(i, i + 1, { timedItems: [timed] });
			return makeCell(i, (i % 31) + 1);
		});
		const compiled: CompiledMonthView = {
			kind: CalendarViewKind.Month,
			rangeStart: 0,
			rangeEnd: 0,
			cells,
		};
		handle = await renderInto(
			<StrictMode>
				<MonthView compiled={compiled} weekStartsOn={WeekStartsOn.Monday} callbacks={cbs()} />
			</StrictMode>,
		);
		const root = handle.container;
		expect(root.querySelectorAll(".cal-month__ribbon").length).toBe(3);
		expect(root.querySelectorAll(".cal-month__ribbon-title").length).toBe(1);
		const chip = root.querySelector(".cal-chip--compact .cal-chip__title");
		expect(chip?.textContent).toBe("Standup");
	});
});

describe("month-view overflow popover", () => {
	it("stays open on inside-scroll, dismisses on outside-scroll (regression)", async () => {
		const items = Array.from({ length: 8 }, (_, i) => makeItem(`evt-${i}`));
		const cells: MonthDayCell[] = Array.from({ length: 42 }, (_, i) =>
			i === 10 ? makeCell(i, i + 1, { timedItems: items }) : makeCell(i, (i % 31) + 1),
		);
		const compiled: CompiledMonthView = {
			kind: CalendarViewKind.Month,
			rangeStart: 0,
			rangeEnd: 0,
			cells,
		};
		handle = await renderInto(
			<MonthView compiled={compiled} weekStartsOn={WeekStartsOn.Monday} callbacks={cbs()} />,
		);
		const pill = handle.container.querySelector<HTMLButtonElement>(".cal-month__overflow-button");
		expect(pill).not.toBeNull();
		pill?.click();
		await flush();

		const panel = document.querySelector(".cal-month__overflow-popover");
		expect(panel).not.toBeNull();

		panel?.dispatchEvent(new Event("scroll", { bubbles: true }));
		await flush();
		expect(document.querySelector(".cal-month__overflow-popover")).not.toBeNull();

		const outside = document.createElement("div");
		document.body.appendChild(outside);
		outside.dispatchEvent(new Event("scroll", { bubbles: true }));
		await flush();
		expect(document.querySelector(".cal-month__overflow-popover")).toBeNull();
	});
});

describe("month-view cross-app object drop (DND-4)", () => {
	function payload(): ObjectDragPayload {
		return {
			v: 1,
			sourceApp: "io.brainstorm.database",
			items: [{ entityId: "task-7", entityType: "brainstorm/Task/v1", label: "Ship release" }],
		};
	}

	function deliverDrop(detail: DropDelivery): void {
		window.dispatchEvent(new CustomEvent(CROSS_APP_DROP_EVENT, { detail }));
	}

	it("routes the drop to the cell UNDER the cursor (rect hit-test), not the last-registered one", async () => {
		const DAY_START = 1_700_006_400_000;
		const cells: MonthDayCell[] = Array.from({ length: 42 }, (_, i) =>
			i === 5 ? makeCell(DAY_START, 6) : makeCell(1_000_000 + i, (i % 31) + 1),
		);
		const compiled: CompiledMonthView = {
			kind: CalendarViewKind.Month,
			rangeStart: 0,
			rangeEnd: 0,
			cells,
		};
		const onDropObject = vi.fn();
		handle = await renderInto(
			<MonthView
				compiled={compiled}
				weekStartsOn={WeekStartsOn.Monday}
				callbacks={cbs({ onDropObject })}
			/>,
		);
		// jsdom gives every element a 0×0 rect, so only the cell whose rect we stub
		// to contain the drop point should match — proving sibling cells route by
		// cursor position now, not registration order (the window-level LIFO bug).
		const dropCells = Array.from(document.querySelectorAll<HTMLElement>(".cal-month__drop"));
		const targetCell = dropCells[5];
		if (!targetCell) throw new Error("drop cells not rendered");
		targetCell.getBoundingClientRect = () =>
			({ left: 0, top: 0, right: 100, bottom: 100, x: 0, y: 0, width: 100, height: 100 }) as DOMRect;
		const pl = payload();
		deliverDrop({
			sessionId: "s1",
			payloadKind: DragPayloadKind.Object,
			payload: pl,
			pointInWindow: { x: 10, y: 10 },
			effect: DropEffect.Link,
		});
		await flush();
		expect(onDropObject).toHaveBeenCalledTimes(1);
		expect(onDropObject).toHaveBeenCalledWith(DAY_START, pl);
	});

	it("does not register a drop target when onDropObject is absent", async () => {
		const cells: MonthDayCell[] = Array.from({ length: 42 }, (_, i) =>
			makeCell(1000 + i, (i % 31) + 1),
		);
		const compiled: CompiledMonthView = {
			kind: CalendarViewKind.Month,
			rangeStart: 0,
			rangeEnd: 0,
			cells,
		};
		handle = await renderInto(
			<MonthView compiled={compiled} weekStartsOn={WeekStartsOn.Monday} callbacks={cbs()} />,
		);
		expect(handle.container.querySelector(".cal-month__drop")).toBeNull();
		// A drop with no registered target is a no-op (no throw).
		expect(() =>
			deliverDrop({
				sessionId: "s2",
				payloadKind: DragPayloadKind.Object,
				payload: payload(),
				pointInWindow: { x: 1, y: 1 },
				effect: DropEffect.Link,
			}),
		).not.toThrow();
	});
});
