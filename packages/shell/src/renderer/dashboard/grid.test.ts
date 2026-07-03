import { describe, expect, it } from "vitest";
import {
	GRID_OUTER_MARGIN,
	GRID_UNIT,
	ICON_FOOTPRINT_H,
	ICON_FOOTPRINT_W,
	LEGACY_GRID_MAX,
	WIDGET_MIN_H,
	WIDGET_MIN_W,
	WIDGET_UNIT,
	WidgetSize,
	cellToPoint,
	clampCell,
	clampWidgetSize,
	firstFreeCell,
	getCellSize,
	isLegacyIconLayout,
	layoutIcons,
	migrateWidgetRecord,
	pointToCell,
	repackIcons,
	widgetFootprint,
	widgetPointToCell,
	widgetRectPx,
} from "./grid";

const VIEWPORT = { x: 1280, y: 720 };

describe("getCellSize", () => {
	it("is a fixed GRID_UNIT square, viewport-independent", () => {
		expect(getCellSize(VIEWPORT)).toEqual({ w: GRID_UNIT, h: GRID_UNIT });
		expect(getCellSize({ x: 100, y: 100 })).toEqual({ w: GRID_UNIT, h: GRID_UNIT });
	});
});

describe("cellToPoint / pointToCell", () => {
	it("cellToPoint = margin + col*unit (the icon's top-left)", () => {
		const point = cellToPoint({ col: 3, row: 2 }, VIEWPORT);
		expect(point.x).toBe(GRID_OUTER_MARGIN + 3 * GRID_UNIT);
		expect(point.y).toBe(GRID_OUTER_MARGIN + 2 * GRID_UNIT);
	});

	it("round-trips a snapped point", () => {
		const cell = { col: 5, row: 4 };
		expect(pointToCell(cellToPoint(cell, VIEWPORT), VIEWPORT)).toEqual(cell);
	});

	it("pointToCell never returns negative coords", () => {
		expect(pointToCell({ x: -100, y: -100 }, VIEWPORT)).toEqual({ col: 0, row: 0 });
	});

	it("pointToCell clamps so the icon box stays on-screen", () => {
		const snapped = pointToCell({ x: VIEWPORT.x * 10, y: VIEWPORT.y * 10 }, VIEWPORT);
		// The icon's right/bottom edge must not pass the viewport edge.
		expect(GRID_OUTER_MARGIN + snapped.col * GRID_UNIT).toBeLessThanOrEqual(
			VIEWPORT.x - GRID_OUTER_MARGIN,
		);
		expect(GRID_OUTER_MARGIN + snapped.row * GRID_UNIT).toBeLessThanOrEqual(
			VIEWPORT.y - GRID_OUTER_MARGIN,
		);
	});

	it("positions are absolute (a cell maps to the same pixel x at any width)", () => {
		const wide = cellToPoint({ col: 6, row: 0 }, { x: 1600, y: 720 });
		const narrow = cellToPoint({ col: 6, row: 0 }, { x: 800, y: 720 });
		expect(narrow.x).toBe(wide.x);
	});
});

describe("clampCell", () => {
	it("floors to non-negative integer cells (no upper bound — free placement)", () => {
		expect(clampCell({ col: -5, row: -5 })).toEqual({ col: 0, row: 0 });
		expect(clampCell({ col: 999, row: 999 })).toEqual({ col: 999, row: 999 });
		expect(clampCell({ col: 3.7, row: 2.2 })).toEqual({ col: 3, row: 2 });
	});
});

describe("firstFreeCell (install placement)", () => {
	it("starts at the origin when nothing is placed", () => {
		expect(firstFreeCell([])).toEqual({ col: 0, row: 0 });
	});

	it("steps by the icon footprint so a new install clears existing ones", () => {
		expect(firstFreeCell([{ col: 0, row: 0 }])).toEqual({ col: ICON_FOOTPRINT_W, row: 0 });
		expect(
			firstFreeCell([
				{ col: 0, row: 0 },
				{ col: ICON_FOOTPRINT_W, row: 0 },
			]),
		).toEqual({ col: 2 * ICON_FOOTPRINT_W, row: 0 });
	});
});

describe("layoutIcons (free placement)", () => {
	it("keeps every icon at its stored cell — no collision resolution", () => {
		expect(
			layoutIcons([
				{ id: "a", col: 1, row: 1 },
				{ id: "b", col: 1, row: 1 },
			]),
		).toEqual([
			{ id: "a", col: 1, row: 1 },
			{ id: "b", col: 1, row: 1 },
		]);
	});

	it("floors negatives to zero but leaves large coords alone", () => {
		expect(layoutIcons([{ id: "x", col: -5, row: 999 }])).toEqual([{ id: "x", col: 0, row: 999 }]);
	});
});

describe("isLegacyIconLayout / repackIcons", () => {
	it("flags a layout where every icon is within the legacy bound", () => {
		expect(
			isLegacyIconLayout([
				{ col: 0, row: 0 },
				{ col: 13, row: 5 },
				{ col: LEGACY_GRID_MAX, row: 2 },
			]),
		).toBe(true);
	});

	it("rejects a spread 8px layout and an empty set", () => {
		expect(
			isLegacyIconLayout([
				{ col: 0, row: 0 },
				{ col: LEGACY_GRID_MAX + 1, row: 0 },
			]),
		).toBe(false);
		expect(isLegacyIconLayout([])).toBe(false);
	});

	it("re-packs ids into a columns-wide footprint-stepped grid", () => {
		expect(repackIcons(["a", "b", "c"], 2)).toEqual([
			{ id: "a", col: 0, row: 0 },
			{ id: "b", col: ICON_FOOTPRINT_W, row: 0 },
			{ id: "c", col: 0, row: ICON_FOOTPRINT_H },
		]);
	});
});

describe("widgetFootprint", () => {
	it("maps each size to its default 8px-cell span", () => {
		expect(widgetFootprint(WidgetSize.Small)).toEqual({ w: 20, h: 20 });
		expect(widgetFootprint(WidgetSize.Medium)).toEqual({ w: 40, h: 20 });
		expect(widgetFootprint(WidgetSize.Large)).toEqual({ w: 40, h: 40 });
	});
});

describe("widgetRectPx", () => {
	it("places on the fixed 8px grid: origin = margin + col*unit, size = span*unit", () => {
		const rect = widgetRectPx({ col: 3, row: 1, w: 40, h: 20 });
		expect(rect.x).toBe(GRID_OUTER_MARGIN + 3 * WIDGET_UNIT);
		expect(rect.y).toBe(GRID_OUTER_MARGIN + 1 * WIDGET_UNIT);
		expect(rect.width).toBe(40 * WIDGET_UNIT);
		expect(rect.height).toBe(20 * WIDGET_UNIT);
	});

	it("clamps negative spans to zero", () => {
		const rect = widgetRectPx({ col: 0, row: 0, w: -1, h: -3 });
		expect(rect.width).toBe(0);
		expect(rect.height).toBe(0);
	});
});

describe("widgetPointToCell", () => {
	it("snaps a window point to the nearest 8px cell (origin-relative)", () => {
		expect(widgetPointToCell({ x: GRID_OUTER_MARGIN + 19, y: GRID_OUTER_MARGIN + 4 })).toEqual({
			col: 2,
			row: 1,
		});
	});
	it("never goes negative", () => {
		expect(widgetPointToCell({ x: 0, y: 0 })).toEqual({ col: 0, row: 0 });
	});
});

describe("clampWidgetSize", () => {
	it("enforces the footprint floor", () => {
		expect(clampWidgetSize({ w: 2, h: 1 })).toEqual({ w: WIDGET_MIN_W, h: WIDGET_MIN_H });
		expect(clampWidgetSize({ w: 30, h: 25 })).toEqual({ w: 30, h: 25 });
	});
});

describe("migrateWidgetRecord", () => {
	it("scales a legacy icon-grid footprint up onto the 8px grid (×10)", () => {
		expect(migrateWidgetRecord({ x: 2, y: 3, w: 2, h: 2 })).toEqual({ x: 20, y: 30, w: 20, h: 20 });
	});
	it("leaves an already-8px record untouched (self-terminating)", () => {
		const rec = { x: 20, y: 30, w: 40, h: 20 };
		expect(migrateWidgetRecord(rec)).toBe(rec);
	});
	it("never re-migrates a current-format widget resized to the minimum footprint (F-379)", () => {
		// WIDGET_MIN_H (6) sits ON the legacy ceiling — a min-height resize must
		// not read as legacy and teleport the record ×10.
		const rec = { x: 4, y: 50, w: WIDGET_MIN_W, h: WIDGET_MIN_H };
		expect(migrateWidgetRecord(rec)).toBe(rec);
	});
	it("still migrates a legacy record whose height alone is tiny only when width is legacy too", () => {
		// Legacy footprints were ≤ 4×4 icon cells; width is the discriminator.
		expect(migrateWidgetRecord({ x: 1, y: 1, w: 4, h: 2 })).toEqual({ x: 10, y: 10, w: 40, h: 20 });
	});
});
