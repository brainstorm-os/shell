// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { addDays, compileGantt, dayStart, prevDayStart, rangeDays } from "../logic/gantt";
import { Priority, type Task } from "../types/task";
import { TIMELINE_METRICS, TimelineZoom, renderTimelineView } from "./timeline-view";

const NOW = new Date(2026, 5, 10, 12, 0, 0).getTime();
const TODAY = dayStart(NOW);

function task(id: string, overrides: Partial<Task> = {}): Task {
	return {
		id,
		name: id,
		completedAt: null,
		priority: Priority.None,
		scheduledAt: null,
		dueAt: null,
		projectId: null,
		assigneeId: null,
		parentId: null,
		recurrence: null,
		statusKey: null,
		createdAt: NOW - 1000,
		updatedAt: NOW - 1000,
		...overrides,
	};
}

function render(tasks: Task[], extra: Partial<Parameters<typeof renderTimelineView>[0]> = {}) {
	const model = compileGantt(tasks, NOW);
	const el = renderTimelineView({ model, now: NOW, ...extra });
	document.body.replaceChildren(el);
	return { model, el };
}

describe("renderTimelineView", () => {
	it("renders the empty state when nothing is dated", () => {
		const { el } = render([task("a")]);
		expect(el.querySelector(".tasks-timeline__empty")).not.toBeNull();
		expect(el.querySelector(".tasks-timeline__unscheduled")?.textContent).toContain("1");
	});

	it("positions bars from the model's day index", () => {
		const { model, el } = render([
			task("one", { scheduledAt: NOW }),
			task("two", { scheduledAt: addDays(TODAY, 2), estimateMinutes: 2 * 24 * 60 }),
		]);
		const days = rangeDays(model);
		const { pxPerDay, laneHeight, axisHeight } = TIMELINE_METRICS;
		const bars = el.querySelectorAll<HTMLElement>(".tasks-timeline__bar");
		expect(bars).toHaveLength(2);

		const oneIdx = days.indexOf(TODAY);
		const one = bars[0] as HTMLElement;
		expect(one.dataset.ganttTaskId).toBe("one");
		expect(one.style.left).toBe(`${oneIdx * pxPerDay}px`);
		expect(one.style.width).toBe(`${pxPerDay}px`);

		const two = bars[1] as HTMLElement;
		expect(two.style.left).toBe(`${days.indexOf(addDays(TODAY, 2)) * pxPerDay}px`);
		expect(two.style.width).toBe(`${2 * pxPerDay}px`);
		expect(two.style.top).toBe(`${axisHeight + laneHeight + (laneHeight - 24) / 2}px`);
	});

	it("marks done / overdue / blocked / derived-start states", () => {
		const { el } = render([
			task("done", { scheduledAt: prevDayStart(TODAY), completedAt: NOW }),
			task("late", { dueAt: prevDayStart(TODAY) }),
			task("gated", { scheduledAt: NOW, dependsOn: ["late"] }),
		]);
		const byId = (id: string) =>
			el.querySelector<HTMLElement>(`.tasks-timeline__bar[data-gantt-task-id="${id}"]`);
		expect(byId("done")?.dataset.state).toBe("done");
		expect(byId("late")?.dataset.state).toBe("overdue");
		expect(byId("late")?.dataset.derivedStart).toBe("true");
		expect(byId("gated")?.dataset.blocked).toBe("true");
	});

	it("paints a won't-do task closed, never overdue", () => {
		const { el } = render([
			task("wont", { dueAt: prevDayStart(TODAY), completedAt: null, statusKey: "cancelled" }),
		]);
		const bar = el.querySelector<HTMLElement>('.tasks-timeline__bar[data-gantt-task-id="wont"]');
		expect(bar?.dataset.state).toBe("done");
	});

	it("draws one dependency edge with an arrowhead", () => {
		const { el } = render([
			task("dep", { scheduledAt: prevDayStart(TODAY) }),
			task("dependent", { scheduledAt: addDays(TODAY, 1), dependsOn: ["dep"] }),
		]);
		const edges = el.querySelectorAll(".tasks-timeline__edge");
		expect(edges).toHaveLength(1);
		expect(edges[0]?.getAttribute("marker-end")).toBe("url(#tasks-timeline-arrow)");
		expect(el.querySelector("marker#tasks-timeline-arrow")).not.toBeNull();
	});

	it("paints the today line inside the range", () => {
		const { model, el } = render([task("a", { scheduledAt: NOW })]);
		const days = rangeDays(model);
		const line = el.querySelector<HTMLElement>(".tasks-timeline__today");
		expect(line?.style.left).toBe(`${(days.indexOf(TODAY) + 0.5) * TIMELINE_METRICS.pxPerDay}px`);
	});

	it("click selects; Enter on the active bar opens", () => {
		const onSelectTask = vi.fn();
		const onOpenEdit = vi.fn();
		const { el } = render(
			[task("one", { scheduledAt: NOW }), task("two", { scheduledAt: addDays(TODAY, 1) })],
			{ onSelectTask, onOpenEdit, selectedTaskId: "two" },
		);
		el.querySelector<HTMLElement>('.tasks-timeline__bar[data-gantt-task-id="one"]')?.click();
		expect(onSelectTask).toHaveBeenCalledWith(expect.objectContaining({ id: "one" }));

		const scroll = el.querySelector<HTMLElement>(".tasks-timeline__scroll");
		expect(scroll?.getAttribute("role")).toBe("grid");
		scroll?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		expect(onOpenEdit).toHaveBeenCalledWith(expect.objectContaining({ id: "two" }));
	});

	it("shows the toolbar only when onSetZoom is wired", () => {
		const { el: withoutZoom } = render([task("a", { scheduledAt: NOW })]);
		expect(withoutZoom.querySelector(".tasks-timeline__toolbar")).toBeNull();

		const { el: withZoom } = render([task("a", { scheduledAt: NOW })], { onSetZoom: () => {} });
		expect(withZoom.querySelector(".tasks-timeline__toolbar")).not.toBeNull();
	});

	it("a denser zoom narrows the day column, re-scaling bar geometry", () => {
		const { model, el } = render([task("one", { scheduledAt: NOW })], {
			zoom: TimelineZoom.Months,
			onSetZoom: () => {},
		});
		const days = rangeDays(model);
		const bar = el.querySelector<HTMLElement>(".tasks-timeline__bar");
		// Months packs days to 12px — narrower than the default Weeks (28px).
		expect(bar?.style.width).toBe("12px");
		expect(bar?.style.left).toBe(`${days.indexOf(TODAY) * 12}px`);
	});

	it("shades weekend columns and separates months in the grid layer", () => {
		const { el } = render([task("spanning", { scheduledAt: NOW, estimateMinutes: 40 * 24 * 60 })]);
		expect(el.querySelectorAll(".tasks-timeline__weekend").length).toBeGreaterThan(0);
		expect(el.querySelectorAll(".tasks-timeline__month-sep").length).toBeGreaterThan(0);
	});

	it("keyboard binding makes the container the single Tab stop", () => {
		const { el } = render([task("one", { scheduledAt: NOW })], { onOpenEdit: () => {} });
		const bar = el.querySelector<HTMLElement>(".tasks-timeline__bar");
		expect(bar?.tabIndex).toBe(-1);
		expect(bar?.dataset.compositeIndex).toBe("0");
	});
});
