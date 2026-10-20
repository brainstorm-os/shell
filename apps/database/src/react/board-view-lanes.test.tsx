// @vitest-environment jsdom
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSwimlanes } from "../logic/board-groups";
import type { CompiledView } from "../logic/compile-view";
import type { EntityRow } from "../logic/in-memory-entities";
import type { BoardLayoutOptions } from "../types/list-view";
import { BoardView, type BoardViewProps } from "./board-view";

function row(id: string, status: string, owner: string): EntityRow {
	return {
		id,
		type: "brainstorm/Task/v1",
		properties: { title: id, status, owner },
		createdAt: 0,
		updatedAt: 0,
		deletedAt: null,
	};
}

const ROWS = [row("a", "todo", "ann"), row("b", "done", "bob"), row("c", "todo", "bob")];
const COMPILED: CompiledView = {
	rows: ROWS,
	groups: [
		{ key: "todo", label: "Todo", rows: [ROWS[0] as EntityRow, ROWS[2] as EntityRow] },
		{ key: "done", label: "Done", rows: [ROWS[1] as EntityRow] },
	],
};
const LAYOUT: BoardLayoutOptions = {
	columnWidth: 260,
	collapseEmptyColumns: false,
	cardPreview: "minimal",
	swimlaneBy: "owner",
};

let root: Root | null = null;
let container: HTMLElement | null = null;

function mount(props: Partial<BoardViewProps>): HTMLElement {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	const host = container;
	act(() =>
		root?.render(
			<BoardView
				compiled={COMPILED}
				columns={[]}
				layout={LAYOUT}
				groupBy={{ propertyId: "status" }}
				subtitleProperty={null}
				selectedIds={new Set()}
				onSelect={vi.fn()}
				onOpen={vi.fn()}
				onMoveToGroup={vi.fn()}
				lanes={buildSwimlanes(ROWS, "owner")}
				{...props}
			/>,
		),
	);
	return host;
}

afterEach(() => {
	act(() => root?.unmount());
	container?.remove();
	root = null;
});

function dropCard(target: Element, entityId: string): void {
	const event = new Event("drop", { bubbles: true, cancelable: true }) as Event & {
		dataTransfer: unknown;
	};
	event.dataTransfer = {
		getData: () => entityId,
		types: ["application/x-brainstorm-entity"],
	};
	act(() => {
		target.dispatchEvent(event);
	});
}

describe("BoardView swimlanes (9.12.28)", () => {
	it("renders one lane per swimlane value with a cell per column", () => {
		const host = mount({});
		const lanes = host.querySelectorAll(".dbv-board__lane");
		expect([...lanes].map((l) => l.getAttribute("data-lane-key"))).toEqual(["ann", "bob"]);
		const bobCells = lanes[1]?.querySelectorAll(".dbv-board__cell");
		expect([...(bobCells ?? [])].map((c) => c.getAttribute("data-group-key"))).toEqual([
			"todo",
			"done",
		]);
		expect(host.querySelectorAll('.dbv-board__column[data-header-only="true"]').length).toBe(2);
	});

	it("dropping a card into a cell moves it on both axes", () => {
		const onMoveToCell = vi.fn();
		const host = mount({ onMoveToCell });
		const cell = host.querySelector('[data-lane-key="ann"] .dbv-board__cell[data-group-key="done"]');
		if (!cell) throw new Error("cell missing");
		dropCard(cell, "b");
		expect(onMoveToCell).toHaveBeenCalledWith(ROWS[1], "done", "ann");
	});

	it("collapse toggles report the lane / column wire key", () => {
		const onToggleLaneCollapsed = vi.fn();
		const onToggleGroupCollapsed = vi.fn();
		const host = mount({ onToggleLaneCollapsed, onToggleGroupCollapsed });
		const laneToggle = host.querySelector<HTMLButtonElement>(
			'[data-lane-key="bob"] .dbv-board__collapse',
		);
		act(() => laneToggle?.click());
		expect(onToggleLaneCollapsed).toHaveBeenCalledWith("bob");
		const colToggle = host.querySelector<HTMLButtonElement>(
			'.dbv-board__column[data-group-key="todo"] .dbv-board__collapse',
		);
		act(() => colToggle?.click());
		expect(onToggleGroupCollapsed).toHaveBeenCalledWith("todo");
	});

	it("a collapsed lane hides its cells; a collapsed column shows a count", () => {
		const host = mount({
			layout: { ...LAYOUT, collapsedLanes: ["ann"], collapsedGroups: ["done"] },
			onToggleLaneCollapsed: vi.fn(),
		});
		expect(host.querySelector('[data-lane-key="ann"] .dbv-board__cell')).toBeNull();
		const doneCell = host.querySelector(
			'[data-lane-key="bob"] .dbv-board__cell[data-group-key="done"]',
		);
		expect(doneCell?.getAttribute("data-collapsed")).toBe("true");
		expect(doneCell?.textContent).toBe("1");
	});
});
