import { describe, expect, it } from "vitest";
import {
	GRID_OUTER_MARGIN,
	GRID_UNIT,
	ICON_FOOTPRINT_H,
	ICON_FOOTPRINT_W,
	LEGACY_GRID_MAX,
	UNPLACED_ICON_POSITION,
	UNPLACED_WIDGET_POSITION,
	WIDGET_MIN_H,
	WIDGET_MIN_W,
	WIDGET_UNIT,
	WidgetSize,
	cellToPoint,
	clampCell,
	clampWidgetOrigin,
	clampWidgetRecordSize,
	clampWidgetSize,
	clampWidgetSizeToSurface,
	getCellSize,
	isLegacyIconLayout,
	isUnplacedWidget,
	layoutIcons,
	matchedWidgetSize,
	migrateWidgetRecord,
	placeWidgetInStage,
	pointToCell,
	reconcileWidgetLayout,
	repackIcons,
	widgetFitsStage,
	widgetFootprint,
	widgetOverlapsIcons,
	widgetPointToCell,
	widgetRectPx,
	widgetsOverlap,
} from "./grid";
import type { GridPoint, WidgetLayout } from "./grid";

const VIEWPORT = { x: 1280, y: 720 };

/** A fully-sized widget record — what every placement assertion below reads. */
type WidgetRecord = { x: number; y: number; w: number; h: number };

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
 * GRID_UNIT` — but nothing reconciled them. `clampWidgetOrigin` only clamps to
 * the SURFACE, so a widget could be persisted directly on top of an app icon
 * and would render there forever.
 *
 * The audit caught exactly that on the untouched dashboard: two widgets
 * painting over the app icon row, one narrow enough that its title clipped to
 * `Rece…`. It survived every POLISH-APP pass because it changes no colour
 * literal and no font size.
 */
describe("placeWidgetInStage — widget ↔ icon collision (327 audit)", () => {
	const surface = { x: 1440, y: 900 };

	it("moves a widget off an occupied icon cell", () => {
		// The defect exactly as the audit saw it: a widget persisted at the
		// icon-row origin rendered on top of the app icons forever.
		const icons = [{ x: 0, y: 0 }];
		const placed = placeWidgetInStage({ x: 0, y: 0, w: 40, h: 20 }, icons, [], surface);
		expect(placed).not.toBeNull();
		expect(widgetOverlapsIcons(placed as WidgetRecord, icons)).toBe(false);
		// Any direction is allowed — what is NOT allowed is leaving the stage.
		expect(widgetFitsStage(placed as WidgetRecord, surface)).toBe(true);
	});

	it("leaves a widget that was already clear exactly where it is", () => {
		const icons = [{ x: 0, y: 0 }];
		const widget = { x: 0, y: 60, w: 40, h: 20 };
		// Identity preserved, so the layer's `changed` check does not churn.
		expect(placeWidgetInStage(widget, icons, [], surface)).toBe(widget);
	});

	it("clears EVERY icon, not just the first", () => {
		const icons = [
			{ x: 0, y: 0 },
			{ x: 0, y: 14 },
			{ x: 0, y: 28 },
		];
		const placed = placeWidgetInStage({ x: 0, y: 0, w: 40, h: 20 }, icons, [], surface);
		expect(widgetOverlapsIcons(placed as WidgetRecord, icons)).toBe(false);
	});

	it("ignores unplaced icons", () => {
		// An unplaced icon has no position to collide with.
		const widget = { x: 0, y: 0, w: 40, h: 20 };
		expect(placeWidgetInStage(widget, [UNPLACED_ICON_POSITION], [], surface)).toBe(widget);
	});

	it("REFUSES rather than parking a widget off the stage", () => {
		// The whole small stage is under icons. The predecessor of this function
		// returned a record parked below every obstacle — header, grip and ⋯
		// menu past a fold that does not scroll, i.e. invisible AND unremovable.
		// `null` is the honest answer, and the caller owes the user a visible
		// state for it.
		const icons = Array.from({ length: 200 }, (_, i) => ({ x: 0, y: i }));
		expect(
			placeWidgetInStage({ x: 0, y: 0, w: 40, h: 20 }, icons, [], { x: 400, y: 200 }),
		).toBeNull();
	});

	it("refuses a footprint larger than the stage itself", () => {
		expect(placeWidgetInStage({ x: 0, y: 0, w: 200, h: 200 }, [], [], { x: 400, y: 200 })).toBeNull();
	});

	it("does nothing when there are no icons at all", () => {
		const widget = { x: 0, y: 0, w: 40, h: 20 };
		expect(placeWidgetInStage(widget, [], [], surface)).toBe(widget);
	});

	it("places nothing (and refuses nothing) on a pre-layout surface", () => {
		const widget = { x: 0, y: 0, w: 40, h: 20 };
		expect(placeWidgetInStage(widget, [{ x: 0, y: 0 }], [], { x: 0, y: 0 })).toBe(widget);
	});
});

/**
 * THE REACHABILITY INVARIANT. `.dashboard__body` is `overflow: hidden` with no
 * scroll and no widget list, so a card past the fold is not merely awkward —
 * its header, grip, resize handle and ⋯ menu are all gone, and the ⋯ is the
 * only way to remove a widget. Every placement this module returns must satisfy
 * this predicate; when it cannot, it refuses.
 */
describe("widgetFitsStage", () => {
	const surface = { x: 1100, y: 660 };

	it("accepts a card wholly inside the stage", () => {
		expect(widgetFitsStage({ x: 0, y: 0, w: 40, h: 40 }, surface)).toBe(true);
	});

	it("rejects a card past the bottom fold — the f10a56dd parking spot", () => {
		// 1100×660 holds rows 0..80; a 40-cell-tall card parked at row 74 (y=592
		// px) ends at row 114, and the two behind it at 116 and 158.
		expect(widgetFitsStage({ x: 0, y: 74, w: 40, h: 40 }, surface)).toBe(false);
		expect(widgetFitsStage({ x: 0, y: 116, w: 40, h: 40 }, surface)).toBe(false);
	});

	it("rejects a card past the right edge, or at a negative origin", () => {
		expect(widgetFitsStage({ x: 120, y: 0, w: 40, h: 20 }, surface)).toBe(false);
		expect(widgetFitsStage({ x: -1, y: 0, w: 40, h: 20 }, surface)).toBe(false);
	});

	it("asserts nothing about a pre-layout surface", () => {
		expect(widgetFitsStage({ x: 999, y: 999, w: 40, h: 40 }, { x: 0, y: 0 })).toBe(true);
	});
});

/**
 * Widget ↔ widget collision (327 audit, second half). PR #448 rescued widgets
 * from the ICON band, but nothing reconciled widgets against each other — two
 * persisted records could still paint on top of one another forever. The layer
 * now processes widgets in persisted order and rescues any record that overlaps
 * an already-placed earlier sibling downward, same shape as the icon rescue.
 */
describe("widgetsOverlap", () => {
	it("detects an intersecting pair and clears a disjoint one", () => {
		const a = { x: 0, y: 0, w: 40, h: 20 };
		expect(widgetsOverlap(a, { x: 10, y: 10, w: 40, h: 20 })).toBe(true);
		// Edge-adjacent is NOT overlapping (half-open rects).
		expect(widgetsOverlap(a, { x: 40, y: 0, w: 40, h: 20 })).toBe(false);
		expect(widgetsOverlap(a, { x: 0, y: 20, w: 40, h: 20 })).toBe(false);
	});

	it("floors a missing footprint at the widget minimum", () => {
		// A bare {x,y} record still occupies the minimum footprint.
		expect(widgetsOverlap({ x: 0, y: 0 }, { x: WIDGET_MIN_W - 1, y: WIDGET_MIN_H - 1 })).toBe(true);
		expect(widgetsOverlap({ x: 0, y: 0 }, { x: WIDGET_MIN_W, y: 0 })).toBe(false);
	});
});

describe("placeWidgetInStage — widget ↔ widget collision (327 audit)", () => {
	const surface = { x: 1440, y: 900 };

	it("separates two overlapping widgets — the later one moves, the earlier stays", () => {
		const a = { x: 0, y: 40, w: 40, h: 20 };
		const b = { x: 10, y: 45, w: 40, h: 20 };
		const placed = placeWidgetInStage(b, [], [a], surface);
		expect(widgetsOverlap(placed as WidgetRecord, a)).toBe(false);
		expect(widgetFitsStage(placed as WidgetRecord, surface)).toBe(true);
	});

	it("moves the LEAST it can — the nearest legal slot, not the first row-major one", () => {
		// A card the user parked at the bottom-right of the stage, overlapped by
		// a sibling. A row-major scan from the stage origin (the shape this
		// replaced) would drag it to the top-left and reshuffle the board around
		// it; nearest-first keeps it in its own corner.
		const sibling = { x: 100, y: 80, w: 40, h: 20 };
		const record = { x: 105, y: 85, w: 40, h: 20 };
		const placed = placeWidgetInStage(record, [], [sibling], surface);
		expect(placed).not.toBeNull();
		const moved = Math.hypot(
			(placed as WidgetRecord).x - record.x,
			(placed as WidgetRecord).y - record.y,
		);
		expect(moved).toBeLessThan(30);
		expect(widgetsOverlap(placed as WidgetRecord, sibling)).toBe(false);
	});

	it("chains — A pushes B pushes C", () => {
		const a = { x: 0, y: 40, w: 40, h: 20 };
		const b = placeWidgetInStage({ x: 0, y: 40, w: 40, h: 20 }, [], [a], surface) as WidgetRecord;
		const c = placeWidgetInStage({ x: 0, y: 40, w: 40, h: 20 }, [], [a, b], surface) as WidgetRecord;
		expect(widgetsOverlap(b, a)).toBe(false);
		expect(widgetsOverlap(c, a)).toBe(false);
		expect(widgetsOverlap(c, b)).toBe(false);
	});

	it("clears icons AND earlier widgets in one pass", () => {
		const icons = [{ x: 0, y: 0 }];
		const a = placeWidgetInStage({ x: 0, y: 0, w: 40, h: 20 }, icons, [], surface) as WidgetRecord;
		const b = placeWidgetInStage({ x: 0, y: 0, w: 40, h: 20 }, icons, [a], surface) as WidgetRecord;
		expect(widgetOverlapsIcons(b, icons)).toBe(false);
		expect(widgetsOverlap(b, a)).toBe(false);
	});

	it("leaves an already-clear widget by identity", () => {
		const a = { x: 0, y: 40, w: 40, h: 20 };
		const clear = { x: 0, y: 70, w: 40, h: 20 };
		expect(placeWidgetInStage(clear, [], [a], surface)).toBe(clear);
	});

	it("refuses when a sibling blankets the whole stage", () => {
		const blanket = { x: 0, y: 0, w: 200, h: 200 };
		expect(
			placeWidgetInStage({ x: 0, y: 0, w: 40, h: 20 }, [], [blanket], { x: 400, y: 200 }),
		).toBeNull();
	});
});

/**
 * The whole-board pass. Two properties beyond "nothing intersects": every card
 * it places is reachable, and adding one card does not reshuffle the others.
 */
describe("reconcileWidgetLayout", () => {
	/** The stage `21-light-01-dashboard.png` was captured on. */
	const STAGE = { x: 1100, y: 660 };
	/** A 20-app fleet packed across the top of that stage. */
	const FLEET = Array.from({ length: 20 }, (_, i) => ({
		x: (i % 12) * 11,
		y: Math.floor(i / 12) * 14,
	}));

	function assertLegal(layout: WidgetLayout<WidgetRecord>, surface: GridPoint): void {
		const placed = Object.entries(layout.placed);
		for (const [id, record] of placed) {
			expect(`${id} in stage: ${widgetFitsStage(record, surface)}`).toBe(`${id} in stage: true`);
			expect(`${id} over icons: ${widgetOverlapsIcons(record, FLEET)}`).toBe(
				`${id} over icons: false`,
			);
		}
		for (let i = 0; i < placed.length; i += 1) {
			for (let j = i + 1; j < placed.length; j += 1) {
				const a = placed[i] as [string, WidgetRecord];
				const b = placed[j] as [string, WidgetRecord];
				expect(`${a[0]} ∩ ${b[0]}: ${widgetsOverlap(a[1], b[1])}`).toBe(`${a[0]} ∩ ${b[0]}: false`);
			}
		}
	}

	it("untangles the audit's own board", () => {
		const layout = reconcileWidgetLayout(
			{
				widget_contacts: { x: 4, y: 2, w: 40, h: 20 },
				widget_notes: { x: 5, y: 6, w: 40, h: 20 },
				widget_journal: { x: 46, y: 8, w: 40, h: 20 },
				widget_chat: { x: 88, y: 10, w: 40, h: 20 },
			},
			FLEET,
			STAGE,
		);
		expect(layout.unplaced).toEqual([]);
		assertLegal(layout, STAGE);
	});

	it("REFUSES the widgets that do not fit instead of parking them off the fold", () => {
		// The exact case the previous fix shipped green: six Large (40×40) cards
		// on the audit's 1100×660 stage under a 20-icon fleet. Cards 4, 5 and 6
		// landed at y=592, y=928 and y=1264 — the last two entirely below a fold
		// that does not scroll. Now the ones with no legal slot come back as
		// `unplaced`, and everything the pass DOES place is reachable.
		const records: Record<string, { x: number; y: number; w: number; h: number }> = {};
		for (let i = 0; i < 6; i += 1) records[`widget_${i}`] = { x: 4, y: 2 + i * 4, w: 40, h: 40 };
		const layout = reconcileWidgetLayout(records, FLEET, STAGE);
		expect(layout.unplaced.length).toBeGreaterThan(0);
		expect(Object.keys(layout.placed).length + layout.unplaced.length).toBe(6);
		assertLegal(layout, STAGE);
	});

	it("adding a widget moves nothing that was already placed", () => {
		const board = {
			widget_a: { x: 4, y: 32, w: 40, h: 20 },
			widget_b: { x: 48, y: 32, w: 40, h: 20 },
			widget_c: { x: 4, y: 56, w: 40, h: 20 },
		};
		const before = reconcileWidgetLayout(board, FLEET, STAGE);
		expect(before.unplaced).toEqual([]);
		// The newcomer lands right on top of widget_a — the worst case for
		// stability, because a global re-flow would re-derive every card.
		const after = reconcileWidgetLayout(
			{ ...board, widget_new: { x: 4, y: 32, w: 20, h: 20 } },
			FLEET,
			STAGE,
		);
		for (const id of Object.keys(board)) {
			expect(`${id} ${JSON.stringify(after.placed[id])}`).toBe(
				`${id} ${JSON.stringify(before.placed[id])}`,
			);
		}
		assertLegal(after, STAGE);
	});

	it("lets the card the user is touching keep its spot — the neighbours yield", () => {
		// Dropping a card onto a sibling that happens to be EARLIER in the map
		// would otherwise teleport the card under the pointer.
		const board = {
			widget_old: { x: 4, y: 32, w: 40, h: 20 },
			widget_dropped: { x: 6, y: 34, w: 40, h: 20 },
		};
		const layout = reconcileWidgetLayout(board, FLEET, STAGE, "widget_dropped");
		expect(layout.placed.widget_dropped).toEqual(board.widget_dropped);
		expect(layout.placed.widget_old).not.toEqual(board.widget_old);
		assertLegal(layout, STAGE);
	});

	it("gives an unplaced (freshly added) widget a real cell", () => {
		const layout = reconcileWidgetLayout(
			{
				widget_new: {
					x: UNPLACED_WIDGET_POSITION.x,
					y: UNPLACED_WIDGET_POSITION.y,
					w: 40,
					h: 20,
				},
			},
			FLEET,
			STAGE,
		);
		expect(layout.unplaced).toEqual([]);
		const placed = layout.placed.widget_new as WidgetRecord;
		expect(isUnplacedWidget(placed)).toBe(false);
		assertLegal(layout, STAGE);
	});

	it("passes records through untouched on a pre-layout surface", () => {
		const record = { x: 900, y: 900, w: 40, h: 20 };
		const layout = reconcileWidgetLayout({ widget_a: record }, FLEET, { x: 0, y: 0 });
		expect(layout.placed.widget_a).toBe(record);
		expect(layout.unplaced).toEqual([]);
	});
});

/**
 * Persisted-footprint floor (327 audit): the resize grip floors at the
 * minimum, but a record with `LEGACY_WIDGET_MAX_CELL < w < WIDGET_MIN_W`
 * slips past both `migrateWidgetRecord` (width above the legacy ceiling) and
 * the gesture clamps (it never went through one) — and renders too narrow to
 * show even its own title ("Rece…").
 */
describe("clampWidgetRecordSize", () => {
	it("clamps a sub-minimum footprint up to the floor", () => {
		expect(clampWidgetRecordSize({ x: 4, y: 50, w: 7, h: 3 })).toEqual({
			x: 4,
			y: 50,
			w: WIDGET_MIN_W,
			h: WIDGET_MIN_H,
		});
	});

	it("returns a conforming record by identity", () => {
		const rec = { x: 4, y: 50, w: 40, h: 20 };
		expect(clampWidgetRecordSize(rec)).toBe(rec);
		const atFloor = { x: 4, y: 50, w: WIDGET_MIN_W, h: WIDGET_MIN_H };
		expect(clampWidgetRecordSize(atFloor)).toBe(atFloor);
	});

	it("clamps one axis without touching the other", () => {
		expect(clampWidgetRecordSize({ x: 0, y: 0, w: 7, h: 20 })).toEqual({
			x: 0,
			y: 0,
			w: WIDGET_MIN_W,
			h: 20,
		});
	});

	it("leaves a record with no size alone", () => {
		const rec: { x: number; y: number; w?: number; h?: number } = { x: 4, y: 50 };
		expect(clampWidgetRecordSize(rec)).toBe(rec);
	});
});
