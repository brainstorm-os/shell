import { describe, expect, it } from "vitest";
import {
	GRID_OUTER_MARGIN,
	GRID_UNIT,
	ICON_BUTTON_W,
	ICON_FOOTPRINT_H,
	ICON_FOOTPRINT_W,
	IconPlacementReason,
	UNPLACED_ICON_POSITION,
	firstFreeIconCell,
	footprintsOverlap,
	iconGridColumns,
	isUnplacedIcon,
	maxIconCol,
	occupiedIconCells,
	resolveIconPlacements,
} from "./dashboard-icon-grid";

/** The stage the POLISH-LAY-9 capture was taken on. */
const STAGE_W = 1440;

/** Pixel left edge of an icon at column `col`, and its right edge. */
function boxRight(col: number): number {
	return GRID_OUTER_MARGIN + col * GRID_UNIT + ICON_BUTTON_W;
}

describe("iconGridColumns", () => {
	it("counts the footprint-wide slots that fit", () => {
		expect(iconGridColumns(STAGE_W)).toBe(16);
		expect(iconGridColumns(1024)).toBe(11);
	});

	it("clamps to at least one column on a surface too narrow for an icon", () => {
		expect(iconGridColumns(40)).toBe(1);
		expect(iconGridColumns(0)).toBe(1);
		expect(iconGridColumns(-500)).toBe(1);
	});

	it("never returns a column whose icon box spills off the surface", () => {
		for (const width of [320, 640, 900, 1024, 1280, 1440, 1920, 2560]) {
			const last = (iconGridColumns(width) - 1) * ICON_FOOTPRINT_W;
			if (width > 2 * GRID_OUTER_MARGIN + ICON_BUTTON_W) {
				expect(boxRight(last)).toBeLessThanOrEqual(width);
			}
		}
	});
});

describe("maxIconCol", () => {
	it("is the last origin whose whole icon box fits", () => {
		const max = maxIconCol(STAGE_W);
		expect(boxRight(max)).toBeLessThanOrEqual(STAGE_W);
		expect(boxRight(max + 1)).toBeGreaterThan(STAGE_W);
	});

	it("floors at the origin for a surface narrower than one icon", () => {
		expect(maxIconCol(40)).toBe(0);
		expect(maxIconCol(0)).toBe(0);
	});
});

describe("isUnplacedIcon", () => {
	it("recognises the sentinel main writes", () => {
		expect(isUnplacedIcon(UNPLACED_ICON_POSITION)).toBe(true);
	});

	it("treats any negative or non-finite coordinate as unplaced", () => {
		expect(isUnplacedIcon({ x: -1, y: 0 })).toBe(true);
		expect(isUnplacedIcon({ x: 0, y: -3 })).toBe(true);
		expect(isUnplacedIcon({ x: Number.NaN, y: 0 })).toBe(true);
	});

	it("leaves a real cell — including the origin — alone", () => {
		expect(isUnplacedIcon({ x: 0, y: 0 })).toBe(false);
		expect(isUnplacedIcon({ x: 11, y: 14 })).toBe(false);
	});
});

describe("occupiedIconCells", () => {
	it("floors every placed record — a dropped record is one the placer would land on", () => {
		expect(
			occupiedIconCells({
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

	it("skips unplaced records rather than parking them on the origin", () => {
		expect(occupiedIconCells({ a: UNPLACED_ICON_POSITION, b: { x: Number.NaN, y: 0 } })).toEqual([]);
	});

	it("is empty for no icons", () => {
		expect(occupiedIconCells({}).length).toBe(0);
	});
});

describe("firstFreeIconCell", () => {
	const COLS = iconGridColumns(STAGE_W);

	it("returns 0:0 on an empty grid", () => {
		expect(firstFreeIconCell([], COLS)).toEqual({ col: 0, row: 0 });
	});

	it("steps a whole icon footprint, not one grid unit (POLISH-LAY-6)", () => {
		const cell = firstFreeIconCell([{ col: 0, row: 0 }], COLS);
		expect(cell).toEqual({ col: ICON_FOOTPRINT_W, row: 0 });
		expect(footprintsOverlap(cell, { col: 0, row: 0 })).toBe(false);
	});

	it("wraps to the next footprint row at the column bound (POLISH-LAY-9)", () => {
		const fullRow = Array.from({ length: COLS }, (_, c) => ({ col: c * ICON_FOOTPRINT_W, row: 0 }));
		expect(firstFreeIconCell(fullRow, COLS)).toEqual({ col: 0, row: ICON_FOOTPRINT_H });
	});

	it("keeps every slot it hands out on-screen for the bound it was given", () => {
		const occupied: { col: number; row: number }[] = [];
		for (let i = 0; i < COLS * 3; i++) {
			const cell = firstFreeIconCell(occupied, COLS);
			expect(boxRight(cell.col)).toBeLessThanOrEqual(STAGE_W);
			occupied.push(cell);
		}
	});

	it("stacks vertically when only one column fits", () => {
		const cells: { col: number; row: number }[] = [];
		for (let i = 0; i < 3; i++) {
			const cell = firstFreeIconCell(cells, iconGridColumns(120));
			cells.push(cell);
		}
		expect(cells).toEqual([
			{ col: 0, row: 0 },
			{ col: 0, row: ICON_FOOTPRINT_H },
			{ col: 0, row: 2 * ICON_FOOTPRINT_H },
		]);
	});

	it("never overlaps ANY icon of a populated fleet", () => {
		const fleet = [
			{ col: 0, row: 0 },
			{ col: ICON_FOOTPRINT_W, row: 0 },
			{ col: 2 * ICON_FOOTPRINT_W, row: 0 },
			{ col: 3 * ICON_FOOTPRINT_W, row: 0 },
			{ col: 0, row: ICON_FOOTPRINT_H },
		];
		const cell = firstFreeIconCell(fleet, COLS);
		for (const icon of fleet) expect(footprintsOverlap(cell, icon)).toBe(false);
	});

	it("places clear of an icon the user dragged off the slot lattice", () => {
		const dragged = { col: 3, row: 3 };
		const cell = firstFreeIconCell([dragged], COLS);
		expect(footprintsOverlap(cell, dragged)).toBe(false);
	});

	it("fills a hole left by an uninstalled app before extending the grid", () => {
		const fleet = [
			{ col: 0, row: 0 },
			{ col: 2 * ICON_FOOTPRINT_W, row: 0 },
		];
		expect(firstFreeIconCell(fleet, COLS)).toEqual({ col: ICON_FOOTPRINT_W, row: 0 });
	});
});

describe("resolveIconPlacements", () => {
	it("leaves a fully placed, on-screen layout untouched (idempotent)", () => {
		const icons = {
			a: { x: 0, y: 0 },
			b: { x: ICON_FOOTPRINT_W, y: 0 },
			c: { x: 0, y: ICON_FOOTPRINT_H },
		};
		expect(resolveIconPlacements(icons, STAGE_W)).toEqual([]);
	});

	it("places an unplaced icon clear of the existing ones", () => {
		const changes = resolveIconPlacements(
			{ a: { x: 0, y: 0 }, newcomer: UNPLACED_ICON_POSITION },
			STAGE_W,
		);
		expect(changes).toEqual([
			{ id: "newcomer", col: ICON_FOOTPRINT_W, row: 0, reason: IconPlacementReason.Unplaced },
		]);
	});

	it("is idempotent — re-resolving a layout it just placed moves nothing", () => {
		const icons: Record<string, { x: number; y: number }> = {
			a: { x: 0, y: 0 },
			newcomer: { ...UNPLACED_ICON_POSITION },
		};
		for (const change of resolveIconPlacements(icons, STAGE_W)) {
			icons[change.id] = { x: change.col, y: change.row };
		}
		expect(resolveIconPlacements(icons, STAGE_W)).toEqual([]);
	});

	it("wraps a batch of unplaced icons onto row 2 at the column bound", () => {
		const cols = iconGridColumns(STAGE_W);
		const icons: Record<string, { x: number; y: number }> = {};
		for (let i = 0; i < cols + 2; i++) icons[`app${i}`] = { ...UNPLACED_ICON_POSITION };
		const changes = resolveIconPlacements(icons, STAGE_W);
		expect(changes).toHaveLength(cols + 2);
		expect(changes[cols]).toEqual({
			id: `app${cols}`,
			col: 0,
			row: ICON_FOOTPRINT_H,
			reason: IconPlacementReason.Unplaced,
		});
		for (const change of changes) expect(boxRight(change.col)).toBeLessThanOrEqual(STAGE_W);
	});

	it("assigns in the map's own key order so a seeded fleet keeps its order", () => {
		const icons = {
			zeta: { ...UNPLACED_ICON_POSITION },
			alpha: { ...UNPLACED_ICON_POSITION },
		};
		expect(resolveIconPlacements(icons, STAGE_W).map((c) => c.id)).toEqual(["zeta", "alpha"]);
	});

	it("rescues icons stored past the right edge, tagged Offscreen", () => {
		const icons = {
			onScreen: { x: 0, y: 0 },
			stranded: { x: 209, y: 0 },
		};
		const changes = resolveIconPlacements(icons, STAGE_W);
		expect(changes).toEqual([
			{ id: "stranded", col: ICON_FOOTPRINT_W, row: 0, reason: IconPlacementReason.Offscreen },
		]);
	});

	it("keeps a hand-dragged icon that is off the slot lattice but fully visible", () => {
		const maxCol = maxIconCol(STAGE_W);
		expect(resolveIconPlacements({ dragged: { x: maxCol, y: 3 } }, STAGE_W)).toEqual([]);
		expect(resolveIconPlacements({ dragged: { x: maxCol + 1, y: 3 } }, STAGE_W)).toHaveLength(1);
	});

	it("does nothing at all before the surface has a width", () => {
		expect(resolveIconPlacements({ a: UNPLACED_ICON_POSITION }, 0)).toEqual([]);
		expect(resolveIconPlacements({ a: UNPLACED_ICON_POSITION }, Number.NaN)).toEqual([]);
	});

	// The captured POLISH-LAY-9 regression, pinned: 20 seeded apps written by
	// main's unbounded placer at 0,0 · 11,0 … 209,0 on a 1440px stage. The 21st
	// install used to land at 220,0 = 1760px — off a surface that doesn't scroll
	// sideways. The renderer must now put it back inside the viewport, and pull
	// the four already-stranded ones (cols 176/187/198/209) back with it.
	it("brings the captured 1440px fleet back on-screen and lands the newcomer inside it", () => {
		const icons: Record<string, { x: number; y: number }> = {};
		for (let i = 0; i < 20; i++) icons[`app${i}`] = { x: i * ICON_FOOTPRINT_W, y: 0 };
		icons.newcomer = { ...UNPLACED_ICON_POSITION };

		const changes = resolveIconPlacements(icons, STAGE_W);
		const byId = new Map(changes.map((c) => [c.id, c]));

		// cols 176, 187, 198, 209 don't fit fully on 1440 — Books/Chat/Forms/Agent.
		expect([...byId.keys()].sort()).toEqual(["app16", "app17", "app18", "app19", "newcomer"].sort());
		for (const change of changes) {
			expect(boxRight(change.col)).toBeLessThanOrEqual(STAGE_W);
			expect(change.row).toBe(ICON_FOOTPRINT_H);
		}
		expect(byId.get("newcomer")?.reason).toBe(IconPlacementReason.Unplaced);
		expect(byId.get("app16")?.reason).toBe(IconPlacementReason.Offscreen);

		// …and every resolved cell is clear of every other icon's footprint.
		const resolvedCells = Object.entries(icons).map(([id, icon]) => {
			const change = byId.get(id);
			return change ? { col: change.col, row: change.row } : { col: icon.x, row: icon.y };
		});
		for (let i = 0; i < resolvedCells.length; i++) {
			for (let j = i + 1; j < resolvedCells.length; j++) {
				const a = resolvedCells[i];
				const b = resolvedCells[j];
				if (!a || !b) throw new Error("unreachable");
				expect(footprintsOverlap(a, b)).toBe(false);
			}
		}
	});
});
