import {
	type LayoutCell,
	LayoutCellKind,
	type LayoutDef,
	LayoutMode,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import type { EntityRow } from "../in-memory-entities";
import {
	cellStyle,
	containerClass,
	freeformExtent,
	groupMode,
	isCellVisible,
	orderedSiblings,
	planSiblings,
	readingOrderRank,
} from "./plan";

const prop = (id: string, property: string, extra: Partial<LayoutCell> = {}): LayoutCell =>
	({ id, kind: LayoutCellKind.Property, property, ...extra }) as LayoutCell;

const entity = (properties: Record<string, unknown>): EntityRow => ({
	id: "ent_1",
	type: "io.example/Person/v1",
	properties,
	createdAt: 0,
	updatedAt: 0,
	deletedAt: null,
});

const def = (partial: Partial<LayoutDef>): LayoutDef => ({
	mode: LayoutMode.Stacked,
	scope: { kind: "type", target: "io.example/Person/v1" },
	context: null,
	cells: [],
	...partial,
});

describe("readingOrderRank + orderedSiblings", () => {
	it("stacked keeps document order", () => {
		const cells = [prop("a", "name"), prop("b", "email")];
		const rank = readingOrderRank(def({ cells }));
		expect(orderedSiblings(cells, rank).map((c) => c.id)).toEqual(["a", "b"]);
	});

	it("an explicit readingOrder drives DOM order, not the cells array", () => {
		const cells = [prop("a", "name"), prop("b", "email"), prop("c", "phone")];
		const rank = readingOrderRank(def({ cells, readingOrder: ["c", "a", "b"] }));
		expect(orderedSiblings(cells, rank).map((c) => c.id)).toEqual(["c", "a", "b"]);
	});

	it("grid DOM order is row-major, so Tab follows the visual rows", () => {
		const cells = [
			prop("bottom", "b", { grid: { col: 1, row: 2 } }),
			prop("topRight", "c", { grid: { col: 2, row: 1 } }),
			prop("topLeft", "a", { grid: { col: 1, row: 1 } }),
		];
		const rank = readingOrderRank(def({ mode: LayoutMode.Grid, cells }));
		expect(orderedSiblings(cells, rank).map((c) => c.id)).toEqual(["topLeft", "topRight", "bottom"]);
	});

	it("is stable for cells the reading order does not mention", () => {
		const cells = [prop("a", "x"), prop("b", "y"), prop("c", "z")];
		// A rank map that knows only "c" — the other two keep document order.
		const rank = new Map([["c", 0]]);
		expect(orderedSiblings(cells, rank).map((c) => c.id)).toEqual(["c", "a", "b"]);
	});

	it("ranks nested group children too (they share one reading order)", () => {
		const group: LayoutCell = {
			id: "g",
			kind: LayoutCellKind.Group,
			cells: [prop("g1", "a"), prop("g2", "b")],
		};
		const rank = readingOrderRank(def({ cells: [group] }));
		expect(rank.get("g1")).toBeDefined();
		expect(rank.get("g2")).toBeDefined();
		expect((rank.get("g2") as number) > (rank.get("g1") as number)).toBe(true);
	});
});

describe("isCellVisible", () => {
	it("a cell without a condition always shows", () => {
		expect(isCellVisible(prop("a", "name"), entity({}))).toBe(true);
	});

	it("hides a cell whose condition fails", () => {
		const cell = prop("a", "phone", { condition: { $eq: { kind: "person" } } });
		expect(isCellVisible(cell, entity({ kind: "company" }))).toBe(false);
	});

	it("shows a cell whose condition holds", () => {
		const cell = prop("a", "phone", { condition: { $eq: { kind: "person" } } });
		expect(isCellVisible(cell, entity({ kind: "person" }))).toBe(true);
	});
});

describe("planSiblings", () => {
	it("filters by condition, then orders", () => {
		const cells = [prop("a", "x", { condition: { $eq: { show: true } } }), prop("b", "y")];
		const rank = readingOrderRank(def({ cells, readingOrder: ["b", "a"] }));
		expect(planSiblings(cells, entity({ show: false }), rank).map((c) => c.id)).toEqual(["b"]);
		expect(planSiblings(cells, entity({ show: true }), rank).map((c) => c.id)).toEqual(["b", "a"]);
	});
});

describe("cellStyle", () => {
	it("stacked needs no per-cell positioning", () => {
		expect(cellStyle(prop("a", "x", { grid: { col: 2, row: 3 } }), LayoutMode.Stacked)).toEqual({});
	});

	it("grid places by col/row", () => {
		expect(cellStyle(prop("a", "x", { grid: { col: 2, row: 3 } }), LayoutMode.Grid)).toEqual({
			gridColumn: "2",
			gridRow: "3",
		});
	});

	it("grid spans render as `start / span n`", () => {
		expect(
			cellStyle(prop("a", "x", { grid: { col: 1, row: 1, colSpan: 3, rowSpan: 2 } }), LayoutMode.Grid),
		).toEqual({ gridColumn: "1 / span 3", gridRow: "1 / span 2" });
	});

	it("a colSpan of 1 stays a bare track (no degenerate span)", () => {
		expect(
			cellStyle(prop("a", "x", { grid: { col: 4, row: 1, colSpan: 1 } }), LayoutMode.Grid).gridColumn,
		).toBe("4");
	});

	it("freeform places absolutely, with optional rotation", () => {
		expect(
			cellStyle(
				prop("a", "x", { freeform: { x: 10, y: 20, width: 100, height: 50 } }),
				LayoutMode.Freeform,
			),
		).toEqual({ position: "absolute", left: "10px", top: "20px", width: "100px", height: "50px" });
		expect(
			cellStyle(
				prop("a", "x", { freeform: { x: 0, y: 0, width: 10, height: 10, rotation: 15 } }),
				LayoutMode.Freeform,
			).transform,
		).toBe("rotate(15deg)");
	});

	it("a cell missing its mode's placement falls back to flow, not 0,0", () => {
		expect(cellStyle(prop("a", "x"), LayoutMode.Grid)).toEqual({});
		expect(cellStyle(prop("a", "x"), LayoutMode.Freeform)).toEqual({});
	});
});

describe("groupMode + containerClass", () => {
	it("a group inherits the container mode unless it declares its own", () => {
		expect(groupMode({}, LayoutMode.Grid)).toBe(LayoutMode.Grid);
		expect(groupMode({ mode: LayoutMode.Stacked }, LayoutMode.Grid)).toBe(LayoutMode.Stacked);
	});

	it("each mode has its own container class", () => {
		expect(containerClass(LayoutMode.Stacked)).toContain("bs-layout--stacked");
		expect(containerClass(LayoutMode.Grid)).toContain("bs-layout--grid");
		expect(containerClass(LayoutMode.Freeform)).toContain("bs-layout--freeform");
	});
});

describe("freeformExtent", () => {
	it("is the bounding box of the placed cells", () => {
		expect(
			freeformExtent([
				prop("a", "x", { freeform: { x: 0, y: 0, width: 100, height: 40 } }),
				prop("b", "y", { freeform: { x: 200, y: 300, width: 50, height: 60 } }),
			]),
		).toEqual({ width: 250, height: 360 });
	});

	it("is null when nothing is placed (the host sizes it)", () => {
		expect(freeformExtent([prop("a", "x")])).toBeNull();
	});
});
