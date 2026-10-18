/**
 * Grid 2D cell-cursor mapping (12.4 — KBN-A-database grid cell-nav).
 *
 * The grid renders a row-virtualized table; arrow-key navigation rides the
 * shared `useCompositeKeyboard` reducer in `Orientation.Grid`, which works
 * on a single FLAT cursor index over `count = rows × columns` cells laid
 * out row-major. These pure helpers translate between that flat index and
 * the (rowIndex, colIndex) pair the renderer needs — to spread the cell's
 * `aria-activedescendant` id, to scroll the cursor's row into the virtual
 * window, and to resolve the entity whose record Enter opens.
 *
 * Kept DOM-free so the mapping is unit-tested without mounting the
 * virtualized grid (which renders empty under jsdom). The arrow-step math
 * itself lives in the SDK reducer and is tested there.
 */

/** Total navigable cells: `rows × columns` (0 when either dimension is 0). */
export function cellCursorCount(rowCount: number, columnCount: number): number {
	if (rowCount <= 0 || columnCount <= 0) return 0;
	return rowCount * columnCount;
}

/** Flat row-major index for the cell at (rowIndex, colIndex). */
export function flatCellIndex(rowIndex: number, colIndex: number, columnCount: number): number {
	return rowIndex * columnCount + colIndex;
}

/** Row of a flat cell index. `columnCount ≤ 0` collapses to row 0. */
export function cellRowOf(flatIndex: number, columnCount: number): number {
	if (columnCount <= 0) return 0;
	return Math.floor(flatIndex / columnCount);
}

/** Column of a flat cell index. `columnCount ≤ 0` collapses to column 0. */
export function cellColOf(flatIndex: number, columnCount: number): number {
	if (columnCount <= 0) return 0;
	return flatIndex % columnCount;
}

/** Clamp a stored cursor to the live cell range, returning `-1` for an empty
 *  grid. Lets the cursor survive a shrinking row/column set without a jarring
 *  reset to the origin (mirrors `useVirtualGridNav`). */
export function clampCellCursor(cursor: number, count: number): number {
	if (count <= 0) return -1;
	if (cursor < 0) return 0;
	if (cursor > count - 1) return count - 1;
	return cursor;
}

/** What Enter (composite Activate) does on the focused cell: the Name column
 *  (wherever the view placed it — `titleIndex`, first by default) opens the
 *  record (the prior row-level Enter); every other column begins in-cell
 *  editing. Pure so the split is unit-tested without the virtualized grid. */
export function cellActivationOpensRecord(
	flatIndex: number,
	columnCount: number,
	titleIndex = 0,
): boolean {
	return cellColOf(flatIndex, columnCount) === titleIndex;
}
