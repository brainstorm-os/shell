import { describe, expect, it } from "vitest";
import {
	ICON_FOOTPRINT_H,
	ICON_FOOTPRINT_W,
	footprintsOverlap,
} from "../../shared/dashboard-icon-grid";
import { firstFreeCell, occupiedCells } from "./grid-placement";

describe("occupiedCells", () => {
	it("keeps every record — a dropped record is one the placer would land on", () => {
		expect(
			occupiedCells({
				a: { x: 0, y: 0 },
				b: { x: 11, y: 0 },
				fractional: { x: 12.5, y: 40.2 },
			}),
		).toEqual([
			{ col: 0, row: 0 },
			{ col: 11, row: 0 },
			{ col: 12, row: 40 },
		]);
	});

	it("clamps negatives to the origin", () => {
		expect(occupiedCells({ a: { x: -4, y: -1 } })).toEqual([{ col: 0, row: 0 }]);
	});

	it("skips non-finite records", () => {
		expect(occupiedCells({ a: { x: Number.NaN, y: 0 } })).toEqual([]);
	});

	it("is empty for no icons", () => {
		expect(occupiedCells({}).length).toBe(0);
	});
});

describe("firstFreeCell", () => {
	it("returns 0:0 on an empty grid", () => {
		expect(firstFreeCell([])).toEqual({ col: 0, row: 0 });
	});

	it("steps a whole icon footprint, not one grid unit (POLISH-LAY-6)", () => {
		// The regression: with Notes at 0,0 the OLD 12-column 1×1-cell scan
		// answered {col:1,row:0} — inside Notes' 11×14-unit box — so the newly
		// installed app's tile and label printed on top of it.
		const cell = firstFreeCell([{ col: 0, row: 0 }]);
		expect(cell).toEqual({ col: ICON_FOOTPRINT_W, row: 0 });
		expect(footprintsOverlap(cell, { col: 0, row: 0 })).toBe(false);
	});

	it("never overlaps ANY icon of a populated seeded fleet", () => {
		// The real seeded layout the dry-run captured: one icon every
		// ICON_FOOTPRINT_W across, wrapping every ICON_FOOTPRINT_H down.
		const fleet = [
			{ col: 0, row: 0 },
			{ col: ICON_FOOTPRINT_W, row: 0 },
			{ col: 2 * ICON_FOOTPRINT_W, row: 0 },
			{ col: 3 * ICON_FOOTPRINT_W, row: 0 },
			{ col: 0, row: ICON_FOOTPRINT_H },
		];
		const cell = firstFreeCell(fleet);
		for (const icon of fleet) expect(footprintsOverlap(cell, icon)).toBe(false);
	});

	it("wraps to the next footprint row when the first row is full", () => {
		const row0 = Array.from({ length: 6 }, (_, c) => ({ col: c * ICON_FOOTPRINT_W, row: 0 }));
		// Six columns is not the whole (unbounded) row, so the placer keeps
		// going across before it wraps.
		expect(firstFreeCell(row0)).toEqual({ col: 6 * ICON_FOOTPRINT_W, row: 0 });
	});

	it("places clear of an icon the user dragged off the slot lattice", () => {
		// Free drags snap to the 8px grid, not to install slots — a dragged
		// icon at 3,3 still blocks the 0,0 slot it overlaps.
		const dragged = { col: 3, row: 3 };
		const cell = firstFreeCell([dragged]);
		expect(footprintsOverlap(cell, dragged)).toBe(false);
	});

	it("fills a hole left by an uninstalled app before extending the grid", () => {
		const fleet = [
			{ col: 0, row: 0 },
			{ col: 2 * ICON_FOOTPRINT_W, row: 0 },
		];
		expect(firstFreeCell(fleet)).toEqual({ col: ICON_FOOTPRINT_W, row: 0 });
	});
});
