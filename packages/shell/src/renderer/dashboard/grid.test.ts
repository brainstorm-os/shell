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
	clampWidgetOrigin,
	clampWidgetSize,
	clampWidgetSizeToSurface,
	getCellSize,
	isLegacyIconLayout,
	layoutIcons,
	matchedWidgetSize,
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
	it("never re-migrates a current-format widget resized to the minimum footprint (F-323)", () => {
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

describe("clampWidgetOrigin", () => {
	const SURFACE = { x: 1024, y: 768 };
	// Max origin so the WHOLE footprint (`w`/`h` cells) stays inside the surface.
	const maxOriginCol = (w: number) => Math.floor((SURFACE.x - GRID_OUTER_MARGIN) / WIDGET_UNIT) - w;
	const maxOriginRow = (h: number) => Math.floor((SURFACE.y - GRID_OUTER_MARGIN) / WIDGET_UNIT) - h;

	it("returns an on-surface record untouched (identity-preserving)", () => {
		const rec = { x: 4, y: 50, w: 40, h: 20 };
		expect(clampWidgetOrigin(rec, SURFACE)).toBe(rec);
	});

	it("keeps the whole footprint on-surface — a card can't overhang the far edge", () => {
		const rec = { x: 40, y: 500, w: 27, h: 20 };
		const clamped = clampWidgetOrigin(rec, SURFACE);
		expect(clamped).toEqual({ x: 40, y: maxOriginRow(20), w: 27, h: 20 });
		// The card's bottom edge sits at or above the surface edge (fully visible).
		expect(GRID_OUTER_MARGIN + (clamped.y + clamped.h) * WIDGET_UNIT).toBeLessThanOrEqual(SURFACE.y);
	});

	it("clamps a stranded horizontal origin so the full width fits", () => {
		const clamped = clampWidgetOrigin({ x: 400, y: 2, w: 20, h: 20 }, SURFACE);
		expect(clamped).toEqual({ x: maxOriginCol(20), y: 2, w: 20, h: 20 });
		expect(GRID_OUTER_MARGIN + (clamped.x + clamped.w) * WIDGET_UNIT).toBeLessThanOrEqual(SURFACE.x);
	});

	it("clamps a wider card in further than a narrow one at the same origin", () => {
		const narrow = clampWidgetOrigin({ x: 400, y: 2, w: 20, h: 20 }, SURFACE);
		const wide = clampWidgetOrigin({ x: 400, y: 2, w: 40, h: 20 }, SURFACE);
		expect(wide.x).toBeLessThan(narrow.x);
	});

	it("falls back to the minimum footprint for a bare {x,y} record with no size", () => {
		expect(clampWidgetOrigin({ x: 400, y: 500 }, SURFACE)).toEqual({
			x: maxOriginCol(WIDGET_MIN_W),
			y: maxOriginRow(WIDGET_MIN_H),
		});
	});

	it("floors at the origin when the surface is smaller than the card", () => {
		expect(clampWidgetOrigin({ x: 12, y: 12, w: 20, h: 20 }, { x: 40, y: 40 })).toEqual({
			x: 0,
			y: 0,
			w: 20,
			h: 20,
		});
	});

	it("clamps nothing against an unknown (zero) surface", () => {
		const rec = { x: 40, y: 500, w: 27, h: 20 };
		expect(clampWidgetOrigin(rec, { x: 0, y: 0 })).toBe(rec);
	});
});

describe("clampWidgetSizeToSurface", () => {
	const SURFACE = { x: 1024, y: 768 };
	const maxW = Math.floor((SURFACE.x - GRID_OUTER_MARGIN) / WIDGET_UNIT);
	const maxH = Math.floor((SURFACE.y - GRID_OUTER_MARGIN) / WIDGET_UNIT);

	it("returns a fitting footprint unchanged (past the floor)", () => {
		expect(clampWidgetSizeToSurface({ col: 4, row: 4 }, { w: 40, h: 20 }, SURFACE)).toEqual({
			w: 40,
			h: 20,
		});
	});

	it("caps a footprint that would spill past the right/bottom edge from its origin", () => {
		const origin = { col: 100, row: 80 };
		const size = clampWidgetSizeToSurface(origin, { w: 60, h: 60 }, SURFACE);
		expect(size.w).toBe(maxW - origin.col);
		expect(size.h).toBe(maxH - origin.row);
		expect(GRID_OUTER_MARGIN + (origin.col + size.w) * WIDGET_UNIT).toBeLessThanOrEqual(SURFACE.x);
		expect(GRID_OUTER_MARGIN + (origin.row + size.h) * WIDGET_UNIT).toBeLessThanOrEqual(SURFACE.y);
	});

	it("still honours the minimum floor", () => {
		expect(clampWidgetSizeToSurface({ col: 0, row: 0 }, { w: 1, h: 1 }, SURFACE)).toEqual({
			w: WIDGET_MIN_W,
			h: WIDGET_MIN_H,
		});
	});

	it("caps nothing against an unknown (zero) surface", () => {
		expect(
			clampWidgetSizeToSurface({ col: 500, row: 500 }, { w: 40, h: 40 }, { x: 0, y: 0 }),
		).toEqual({ w: 40, h: 40 });
	});
});

/**
 * F-462 — the widget Size menu has to be able to say "none of these".
 *
 * `current = w === fp.w && h === fp.h` against three presets left every row
 * unmarked for any hand-resized widget, because the resize grip writes
 * arbitrary units. `matchedWidgetSize` makes that state representable.
 */
describe("matchedWidgetSize (F-462)", () => {
	it("names each preset footprint", () => {
		expect(matchedWidgetSize(widgetFootprint(WidgetSize.Small))).toBe(WidgetSize.Small);
		expect(matchedWidgetSize(widgetFootprint(WidgetSize.Medium))).toBe(WidgetSize.Medium);
		expect(matchedWidgetSize(widgetFootprint(WidgetSize.Large))).toBe(WidgetSize.Large);
	});

	it("returns null for a size the user dragged to", () => {
		// The reported case: any freehand resize lands between presets, and the
		// menu must not claim one of them is current.
		expect(matchedWidgetSize({ w: 33, h: 27 })).toBeNull();
		expect(matchedWidgetSize({ w: 21, h: 20 })).toBeNull();
	});

	it("compares BOTH axes — presets share a width and a height", () => {
		// Small (20x20) and Medium (40x20) share a height; Medium (40x20) and
		// Large (40x40) share a width. Matching one axis would mislabel these.
		expect(matchedWidgetSize({ w: 20, h: 40 })).toBeNull();
		expect(matchedWidgetSize({ w: 40, h: 30 })).toBeNull();
	});
});

/**
 * Widget ↔ icon collision (found by the 327 screenshot audit).
 *
 * Widgets and icons are placed on ONE coordinate system — both are
 * `GRID_OUTER_MARGIN + cell * unit` from the same origin, and `WIDGET_UNIT ===
 * GRID_UNIT` — but nothing reconciles them. `clampWidgetOrigin` only clamps to
 * the SURFACE, and `DashboardWidgetsLayerProps` is `{ widgets }` with no icon
 * data at all, so a widget can be persisted directly on top of an app icon and
 * will render there forever.
 *
 * The audit caught exactly that on the untouched dashboard: two widgets
 * painting over the app icon row, one narrow enough that its title clipped to
 * `Rece…`. It survived every POLISH-APP pass because it changes no colour
 * literal and no font size.
 *
 * These are SKIPPED, not failing: they specify the contract the fix must meet
 * rather than redefining today's behaviour as correct. Un-skip with the fix.
 */
describe.skip("widget ↔ icon collision (327 audit)", () => {
	it("does not leave a widget on top of an occupied icon cell", () => {
		// An icon occupies the top-left footprint; a widget persisted at the same
		// origin must be relocated, not rendered over it.
		const icons = [{ x: 0, y: 0 }];
		const widget = { x: 0, y: 0, w: 40, h: 20 };
		const placed = clampWidgetOrigin(widget, { x: 1440, y: 900 });
		// Today this returns the widget unchanged — that is the defect.
		expect(overlapsAnyIcon(placed, icons)).toBe(false);
	});

	it("keeps a widget that was already clear of the icons where it is", () => {
		const icons = [{ x: 0, y: 0 }];
		const widget = { x: 0, y: 60, w: 40, h: 20 };
		expect(clampWidgetOrigin(widget, { x: 1440, y: 900 })).toEqual(widget);
	});
});

/** Pixel-space overlap between a widget record and any icon footprint. Both
 *  live on the same origin and unit, so the comparison is direct. */
function overlapsAnyIcon(
	widget: { x: number; y: number; w?: number; h?: number },
	icons: readonly { x: number; y: number }[],
): boolean {
	const wx = GRID_OUTER_MARGIN + widget.x * WIDGET_UNIT;
	const wy = GRID_OUTER_MARGIN + widget.y * WIDGET_UNIT;
	const ww = (widget.w ?? 0) * WIDGET_UNIT;
	const wh = (widget.h ?? 0) * WIDGET_UNIT;
	return icons.some((icon) => {
		const ix = GRID_OUTER_MARGIN + icon.x * GRID_UNIT;
		const iy = GRID_OUTER_MARGIN + icon.y * GRID_UNIT;
		return (
			wx < ix + ICON_FOOTPRINT_W * GRID_UNIT &&
			wx + ww > ix &&
			wy < iy + ICON_FOOTPRINT_H * GRID_UNIT &&
			wy + wh > iy
		);
	});
}
