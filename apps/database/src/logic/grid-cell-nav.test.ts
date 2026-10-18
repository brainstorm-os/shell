import { describe, expect, it } from "vitest";
import {
	cellActivationOpensRecord,
	cellColOf,
	cellCursorCount,
	cellRowOf,
	clampCellCursor,
	flatCellIndex,
} from "./grid-cell-nav";

describe("cellCursorCount", () => {
	it("is rows × columns", () => {
		expect(cellCursorCount(4, 3)).toBe(12);
	});
	it("is 0 when either dimension is empty", () => {
		expect(cellCursorCount(0, 3)).toBe(0);
		expect(cellCursorCount(4, 0)).toBe(0);
		expect(cellCursorCount(-1, 3)).toBe(0);
	});
});

describe("flat ↔ (row, col) round-trip", () => {
	it("maps row-major and inverts", () => {
		const columns = 3;
		for (let row = 0; row < 5; row += 1) {
			for (let col = 0; col < columns; col += 1) {
				const flat = flatCellIndex(row, col, columns);
				expect(cellRowOf(flat, columns)).toBe(row);
				expect(cellColOf(flat, columns)).toBe(col);
			}
		}
	});

	it("lays cells out row-major", () => {
		expect(flatCellIndex(0, 0, 3)).toBe(0);
		expect(flatCellIndex(0, 2, 3)).toBe(2);
		expect(flatCellIndex(1, 0, 3)).toBe(3);
		expect(flatCellIndex(2, 1, 3)).toBe(7);
	});

	it("collapses to row/col 0 when columnCount is non-positive", () => {
		expect(cellRowOf(5, 0)).toBe(0);
		expect(cellColOf(5, 0)).toBe(0);
	});
});

describe("clampCellCursor", () => {
	it("returns -1 for an empty grid", () => {
		expect(clampCellCursor(0, 0)).toBe(-1);
		expect(clampCellCursor(3, 0)).toBe(-1);
	});
	it("clamps into [0, count-1]", () => {
		expect(clampCellCursor(-2, 12)).toBe(0);
		expect(clampCellCursor(5, 12)).toBe(5);
		expect(clampCellCursor(99, 12)).toBe(11);
	});
	it("keeps an in-range cursor when the grid shrinks", () => {
		// cursor 7 in a 4×3 grid (count 12) survives a shrink to 3×3 (count 9)
		expect(clampCellCursor(7, 9)).toBe(7);
		// but a cursor past the new end snaps to the last cell, not to 0
		expect(clampCellCursor(11, 9)).toBe(8);
	});
});

describe("cellActivationOpensRecord", () => {
	const columns = 3;
	it("opens the record from the pinned Name column (col 0)", () => {
		expect(cellActivationOpensRecord(0, columns)).toBe(true); // row 0, col 0
		expect(cellActivationOpensRecord(3, columns)).toBe(true); // row 1, col 0
		expect(cellActivationOpensRecord(6, columns)).toBe(true); // row 2, col 0
	});
	it("begins in-cell editing from every other column", () => {
		expect(cellActivationOpensRecord(1, columns)).toBe(false); // row 0, col 1
		expect(cellActivationOpensRecord(2, columns)).toBe(false); // row 0, col 2
		expect(cellActivationOpensRecord(5, columns)).toBe(false); // row 1, col 2
	});

	it("follows the Name column when the view moved it (9.12.29)", () => {
		expect(cellActivationOpensRecord(2, 3, 2)).toBe(true);
		expect(cellActivationOpensRecord(0, 3, 2)).toBe(false);
	});
});
