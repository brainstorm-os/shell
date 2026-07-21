// @vitest-environment jsdom
import { IconKind } from "@brainstorm-os/sdk-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompiledDayView, CompiledWeekView, WeekDayBucket } from "../../logic/compile-view";
import { EVENT_SOURCE_KEY, type ScheduledItem } from "../../logic/scheduled-item";
import { renderInto } from "../../test/render";
import { CalendarViewKind } from "../../types/calendar-view";
import type { ViewCallbacks } from "./view-callbacks";
import { WeekView } from "./week-view";

const DAY_START = new Date(2026, 4, 14, 0, 0, 0, 0).getTime();
const HOUR = 3_600_000;

function makeItem(over: Partial<ScheduledItem> & { id: string; start: number }): ScheduledItem {
	return {
		sourceKey: EVENT_SOURCE_KEY,
		sourceEntityId: over.id,
		title: "Item",
		icon: null,
		end: over.start + HOUR,
		allDay: false,
		location: null,
		recurrence: null,
		colorHint: null,
		...over,
	};
}

function dayBucket(over: Partial<WeekDayBucket> = {}): WeekDayBucket {
	return {
		dayStart: DAY_START,
		dateKey: "2026-05-14",
		isToday: false,
		isWeekend: false,
		allDayItems: [],
		timedItems: [],
		...over,
	};
}

function dayView(day: WeekDayBucket): CompiledDayView {
	return {
		kind: CalendarViewKind.Day,
		rangeStart: day.dayStart,
		rangeEnd: day.dayStart + 24 * HOUR,
		day,
	};
}

function weekView(days: WeekDayBucket[]): CompiledWeekView {
	return {
		kind: CalendarViewKind.Week,
		rangeStart: days[0]?.dayStart ?? DAY_START,
		rangeEnd: (days[0]?.dayStart ?? DAY_START) + 7 * 24 * HOUR,
		days,
	};
}

function cbs(over: Partial<ViewCallbacks> = {}): WeekViewCb {
	return {
		onItemClick: vi.fn(),
		onEmptyCellClick: vi.fn(),
		objectMenu: vi.fn(() => null),
		onReschedule: vi.fn(),
		...over,
	};
}
type WeekViewCb = Pick<
	ViewCallbacks,
	"onItemClick" | "onEmptyCellClick" | "objectMenu" | "onReschedule"
>;

let handle: Awaited<ReturnType<typeof renderInto>> | null = null;
afterEach(async () => {
	await handle?.unmount();
	handle = null;
});

describe("week/day view hour slots", () => {
	it("renders one clickable slot per hour", async () => {
		handle = await renderInto(
			<WeekView compiled={dayView(dayBucket())} now={DAY_START + 9 * HOUR} callbacks={cbs()} />,
		);
		expect(handle.container.querySelectorAll(".cal-week__slot")).toHaveLength(24);
	});

	it("composes an event starting at the clicked hour", async () => {
		const onEmptyCellClick = vi.fn();
		handle = await renderInto(
			<WeekView
				compiled={dayView(dayBucket())}
				now={DAY_START}
				callbacks={cbs({ onEmptyCellClick })}
			/>,
		);
		const slots = handle.container.querySelectorAll<HTMLButtonElement>(".cal-week__slot");
		slots[9]?.click();
		expect(onEmptyCellClick).toHaveBeenCalledWith(DAY_START + 9 * HOUR);
	});

	it("tags the day view with data-kind=day", async () => {
		handle = await renderInto(
			<WeekView compiled={dayView(dayBucket())} now={DAY_START} callbacks={cbs()} />,
		);
		expect(handle.container.querySelector(".cal-week")?.getAttribute("data-kind")).toBe("day");
	});
});

describe("event chip icons", () => {
	it("paints the object's own icon on a timed block when set", async () => {
		const day = dayBucket({
			timedItems: [
				makeItem({
					id: "evt-1",
					start: DAY_START + 10 * HOUR,
					icon: { kind: IconKind.Emoji, value: "📊" },
				}),
			],
		});
		handle = await renderInto(<WeekView compiled={dayView(day)} now={DAY_START} callbacks={cbs()} />);
		expect(handle.container.querySelector(".cal-chip--block .cal-chip__icon")).not.toBeNull();
	});

	it("renders no icon element when the item has none", async () => {
		const day = dayBucket({
			timedItems: [makeItem({ id: "evt-2", start: DAY_START + 10 * HOUR, icon: null })],
		});
		handle = await renderInto(
			<WeekView compiled={weekView([day])} now={DAY_START} callbacks={cbs()} />,
		);
		expect(handle.container.querySelector(".cal-chip__icon")).toBeNull();
	});
});
