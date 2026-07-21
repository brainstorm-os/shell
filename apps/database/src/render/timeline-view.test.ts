// @vitest-environment jsdom
/**
 * KBN-A-database timeline keyboard — the item bars form one listbox
 * (Up/Down between bars, Enter opens). Bars are real DOM buttons (not
 * virtualized), so the wiring is exercised here; only horizontal
 * scroll-into-view needs the real shell.
 */

import { TimelineDensity } from "@brainstorm-os/sdk-types";
import { describe, expect, it, vi } from "vitest";
import type { EntityRow } from "../logic/in-memory-entities";
import type { TimelineLayoutOptions } from "../types/list-view";
import { renderTimelineView } from "./timeline-view";

const L = (y: number, m1: number, d: number): number => new Date(y, m1 - 1, d).getTime();

function row(id: string, d: number): EntityRow {
	return {
		id,
		type: "io.brainstorm.demo/Task/v1",
		properties: { title: id, d },
		createdAt: 0,
		updatedAt: 0,
		deletedAt: null,
	};
}

const layout: TimelineLayoutOptions = {
	primaryDateProperty: "d",
	endDateProperty: null,
	swimlaneBy: null,
	pxPerDay: 20,
	showNow: false,
	showWeekends: false,
	dependencyLinkTypes: [],
	showDependencies: false,
	density: TimelineDensity.Comfortable,
	colorBy: null,
	labelProperty: "title",
};

function mount() {
	const rows = [row("a", L(2026, 6, 10)), row("b", L(2026, 6, 12)), row("c", L(2026, 6, 14))];
	const onOpen = vi.fn();
	const host = document.createElement("div");
	document.body.appendChild(host);
	renderTimelineView(host, {
		compiled: { rows, groups: [] },
		layout,
		selectedIds: new Set<string>(),
		onSelect: vi.fn(),
		onOpen,
	});
	return { host, onOpen };
}

describe("renderTimelineView — keyboard", () => {
	it("makes the scroll container a grid with the bars as one Tab stop", () => {
		const { host } = mount();
		const scroll = host.querySelector<HTMLElement>(".dbv-tl__scroll");
		expect(scroll?.getAttribute("role")).toBe("grid");
		expect(scroll?.tabIndex).toBe(0);
		const bars = host.querySelectorAll<HTMLElement>(".dbv-tl__marker");
		expect(bars.length).toBe(3);
		expect(bars[0]?.dataset.compositeIndex).toBe("0");
		expect(bars[0]?.getAttribute("role")).toBe("gridcell");
		expect(bars[0]?.tabIndex).toBe(-1);
	});

	it("Down moves the cursor and Enter opens the focused record", () => {
		const { host, onOpen } = mount();
		const scroll = host.querySelector<HTMLElement>(".dbv-tl__scroll");
		if (!scroll) throw new Error("no scroll container");
		scroll.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		scroll.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		expect(onOpen).toHaveBeenCalledTimes(1);
		expect((onOpen.mock.calls[0]?.[0] as EntityRow).id).toBe("b");
	});
});

/* 9.12.10 — drag interactions. jsdom has no PointerEvent constructor; the
 * handlers only read clientX / button / target, so MouseEvents dispatched
 * under the pointer* type names exercise the full path. */

const spanLayout: TimelineLayoutOptions = { ...layout, endDateProperty: "e" };

function spanRow(id: string, start: number, end: number): EntityRow {
	return {
		id,
		type: "io.brainstorm.demo/Task/v1",
		properties: { title: id, d: start, e: end },
		createdAt: 0,
		updatedAt: 0,
		deletedAt: null,
	};
}

function mountSpans() {
	const start = L(2026, 6, 10);
	const end = L(2026, 6, 13);
	const onMoveItem = vi.fn();
	const onResizeItem = vi.fn();
	const onSelect = vi.fn();
	const host = document.createElement("div");
	document.body.appendChild(host);
	renderTimelineView(host, {
		compiled: { rows: [spanRow("s1", start, end)], groups: [] },
		layout: spanLayout,
		selectedIds: new Set<string>(),
		onSelect,
		onOpen: vi.fn(),
		onMoveItem,
		onResizeItem,
	});
	return { host, onMoveItem, onResizeItem, onSelect, start, end };
}

function pointer(type: string, x: number): MouseEvent {
	return new MouseEvent(type, { clientX: x, button: 0, bubbles: true });
}

const DAY = 24 * 60 * 60 * 1000;

describe("renderTimelineView — drag to move / resize (9.12.10)", () => {
	it("dragging a bar two days right commits the shifted start + end", () => {
		const { host, onMoveItem, onSelect, start, end } = mountSpans();
		const bar = host.querySelector<HTMLElement>(".dbv-tl__bar");
		if (!bar) throw new Error("no bar");
		bar.dispatchEvent(pointer("pointerdown", 100));
		bar.dispatchEvent(pointer("pointermove", 140)); // 40px @ 20px/day = 2 days
		expect(bar.dataset.dragging).toBe("true");
		bar.dispatchEvent(pointer("pointerup", 140));
		expect(onMoveItem).toHaveBeenCalledTimes(1);
		expect(onMoveItem).toHaveBeenCalledWith(
			expect.objectContaining({ id: "s1" }),
			start + 2 * DAY,
			end + 2 * DAY,
		);
		// The release click is swallowed — a drag is not a selection toggle.
		bar.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(onSelect).not.toHaveBeenCalled();
	});

	it("a sub-threshold press stays a click (no move commit)", () => {
		const { host, onMoveItem, onSelect } = mountSpans();
		const bar = host.querySelector<HTMLElement>(".dbv-tl__bar");
		if (!bar) throw new Error("no bar");
		bar.dispatchEvent(pointer("pointerdown", 100));
		bar.dispatchEvent(pointer("pointermove", 102));
		bar.dispatchEvent(pointer("pointerup", 102));
		expect(onMoveItem).not.toHaveBeenCalled();
		bar.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(onSelect).toHaveBeenCalledTimes(1);
	});

	it("dragging the right edge commits the resized end, clamped >= start", () => {
		const { host, onResizeItem, onMoveItem, start } = mountSpans();
		const handle = host.querySelector<HTMLElement>(".dbv-tl__resize");
		if (!handle) throw new Error("no resize handle");
		handle.dispatchEvent(pointer("pointerdown", 200));
		handle.dispatchEvent(pointer("pointermove", 100)); // -100px = -5 days, span is 3 days
		handle.dispatchEvent(pointer("pointerup", 100));
		expect(onResizeItem).toHaveBeenCalledTimes(1);
		expect(onResizeItem).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }), start);
		expect(onMoveItem).not.toHaveBeenCalled();
	});

	it("renders no resize handle when the host is read-only", () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		renderTimelineView(host, {
			compiled: { rows: [spanRow("s1", L(2026, 6, 10), L(2026, 6, 13))], groups: [] },
			layout: spanLayout,
			selectedIds: new Set<string>(),
			onSelect: vi.fn(),
			onOpen: vi.fn(),
		});
		expect(host.querySelector(".dbv-tl__resize")).toBeNull();
	});
});

describe("renderTimelineView — dependency arrows (9.12.10)", () => {
	const depLayout: TimelineLayoutOptions = {
		...spanLayout,
		dependencyLinkTypes: ["depends-on"],
		showDependencies: true,
	};
	const depRows = [
		spanRow("p", L(2026, 6, 1), L(2026, 6, 4)),
		spanRow("q", L(2026, 6, 6), L(2026, 6, 9)),
	];
	const depLink = { sourceEntityId: "p", destEntityId: "q", linkType: "depends-on" };

	it("draws one arrow per allowed link between visible items", () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		renderTimelineView(host, {
			compiled: { rows: depRows, groups: [] },
			layout: depLayout,
			selectedIds: new Set<string>(),
			onSelect: vi.fn(),
			onOpen: vi.fn(),
			links: [depLink, { sourceEntityId: "p", destEntityId: "q", linkType: "mentions" }],
		});
		const svg = host.querySelector(".dbv-tl__deps");
		expect(svg).not.toBeNull();
		expect(svg?.querySelectorAll(".dbv-tl__dep").length).toBe(1);
	});

	it("draws nothing when showDependencies is off", () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		renderTimelineView(host, {
			compiled: { rows: depRows, groups: [] },
			layout: { ...depLayout, showDependencies: false },
			selectedIds: new Set<string>(),
			onSelect: vi.fn(),
			onOpen: vi.fn(),
			links: [depLink],
		});
		expect(host.querySelector(".dbv-tl__deps")).toBeNull();
	});
});

describe("renderTimelineView — empty states (F-211)", () => {
	it("names the bound property and points at the Dates page when values are missing", () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		renderTimelineView(host, {
			// Rows DO carry a date-typed property — just not the bound one.
			compiled: {
				rows: [row("a", L(2026, 6, 10))],
				groups: [],
			},
			layout: { ...layout, primaryDateProperty: "publishAt" },
			selectedIds: new Set<string>(),
			onSelect: vi.fn(),
			onOpen: vi.fn(),
		});
		const empty = host.querySelector(".dbv-empty");
		expect(empty?.textContent).toContain("Publish at");
		expect(empty?.textContent).toContain("View settings → Dates");
	});

	it("says a date column must exist first when the rows have none at all", () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const dateless: EntityRow = {
			id: "x",
			type: "io.brainstorm.demo/Task/v1",
			properties: { title: "x", status: "open" },
			createdAt: 0,
			updatedAt: 0,
			deletedAt: null,
		};
		renderTimelineView(host, {
			compiled: { rows: [dateless], groups: [] },
			layout,
			selectedIds: new Set<string>(),
			onSelect: vi.fn(),
			onOpen: vi.fn(),
		});
		const empty = host.querySelector(".dbv-empty");
		expect(empty?.textContent).toContain("no date property");
	});
});
