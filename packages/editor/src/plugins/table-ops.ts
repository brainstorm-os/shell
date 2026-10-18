/**
 * Thin, named wrappers over `@lexical/table`'s structural mutators. The
 * `__EXPERIMENTAL` helpers act on whatever table the current selection is
 * in, so every op here is "selection-relative" — the contextual table
 * toolbar guarantees the selection is inside a cell before calling.
 *
 * Centralising them keeps feature code free of the unstable underscore
 * API and gives one place to adjust if Lexical renames it.
 */

import {
	$deleteTableColumn__EXPERIMENTAL,
	$deleteTableRow__EXPERIMENTAL,
	$getTableCellNodeFromLexicalNode,
	$getTableColumnIndexFromTableCellNode,
	$insertTableColumn__EXPERIMENTAL,
	$insertTableRow__EXPERIMENTAL,
	$isTableCellNode,
	$isTableNode,
	$isTableRowNode,
	$isTableSelection,
	TableCellHeaderStates,
	type TableCellNode,
	type TableRowNode,
} from "@lexical/table";
import {
	$createParagraphNode,
	$createTextNode,
	$getNodeByKey,
	$getRoot,
	$getSelection,
	$isRangeSelection,
	type LexicalEditor,
	type NodeKey,
} from "lexical";

/** The cells the selection covers: every cell of a table (multi-cell)
 *  selection, else the cell holding the caret. Must run inside an update. */
function $selectedTableCells(): TableCellNode[] {
	const selection = $getSelection();
	if ($isTableSelection(selection)) return selection.getNodes().filter($isTableCellNode);
	if (!$isRangeSelection(selection)) return [];
	const cell = $getTableCellNodeFromLexicalNode(selection.anchor.getNode());
	return cell ? [cell] : [];
}

/** Tint the selected cell(s) with a theme block-background token (B11.23);
 *  `null` clears it. Persists as Lexical's own cell `backgroundColor`. */
export function setTableCellBackground(editor: LexicalEditor, token: string | null): void {
	editor.update(
		() => {
			for (const cell of $selectedTableCells()) cell.setBackgroundColor(token);
		},
		{ discrete: true },
	);
}

/** Minimum width (px) a table column can be dragged to. */
export const MIN_TABLE_COLUMN_WIDTH = 48;

export enum TableAxis {
	Row = "row",
	Column = "column",
}

export enum TableEdge {
	Before = "before",
	After = "after",
}

/** Insert a row/column relative to the selected cell. */
export function insertTableLine(editor: LexicalEditor, axis: TableAxis, edge: TableEdge): void {
	editor.update(() => {
		const after = edge === TableEdge.After;
		if (axis === TableAxis.Row) $insertTableRow__EXPERIMENTAL(after);
		else $insertTableColumn__EXPERIMENTAL(after);
	});
}

/** Delete the row/column containing the selection. If that empties the
 *  table, the table node is removed and a paragraph takes its place so
 *  the document is never left with a zero-row table. */
export function deleteTableLine(editor: LexicalEditor, axis: TableAxis): void {
	editor.update(() => {
		if (axis === TableAxis.Row) $deleteTableRow__EXPERIMENTAL();
		else $deleteTableColumn__EXPERIMENTAL();
		pruneEmptyTables();
	});
}

/** Remove the whole table the selection sits in. */
export function deleteTable(editor: LexicalEditor): void {
	editor.update(() => {
		const table = currentTableNode();
		if (!table) return;
		const replacement = $createParagraphNode();
		table.replace(replacement);
		replacement.selectStart();
	});
}

/** Toggle the first row between header and body cells. Mirrors the
 *  common "header row" affordance — flips every cell in row 0 between
 *  the ROW header state and NO_STATUS based on the current majority. */
export function toggleHeaderRow(editor: LexicalEditor): void {
	editor.update(() => {
		const table = currentTableNode();
		if (!table) return;
		const firstRow = table.getFirstChild();
		if (!firstRow || !$isTableRowNode(firstRow)) return;
		const cells = firstRow.getChildren().filter($isTableCellNode);
		if (cells.length === 0) return;
		const anyHeader = cells.some(
			(cell) => (cell.getHeaderStyles() & TableCellHeaderStates.ROW) !== 0,
		);
		const next = anyHeader ? TableCellHeaderStates.NO_STATUS : TableCellHeaderStates.ROW;
		for (const cell of cells) cell.setHeaderStyles(next, TableCellHeaderStates.ROW);
	});
}

/** True when the current selection is inside a table cell. Must be
 *  called within an editor read/update. */
export function selectionInTable(): boolean {
	return currentTableNode() !== null;
}

/** Sort the body rows of the table the selection is in by the selected
 *  cell's column. A leading header row (first row's first cell carries a
 *  header state) stays pinned. Numeric columns sort numerically, otherwise
 *  by locale string compare; `ascending` flips the direction. Re-appending
 *  a row moves it to the table's end, so appending the body in sorted order
 *  leaves `[header, …sorted body]`. (v1 reads cells by visual index — exotic
 *  merged-cell layouts aren't reordered.) */
export function sortTableBySelectedColumn(editor: LexicalEditor, ascending: boolean): void {
	editor.update(() => {
		const selection = $getSelection();
		if (!$isRangeSelection(selection)) return;
		const cell = $getTableCellNodeFromLexicalNode(selection.anchor.getNode());
		if (!$isTableCellNode(cell)) return;
		const table = cell.getParent()?.getParent();
		if (!table || !$isTableNode(table)) return;
		const columnIndex = $getTableColumnIndexFromTableCellNode(cell);
		const rows = table.getChildren().filter($isTableRowNode);
		if (rows.length < 2) return;
		const first = rows[0];
		const firstCell = first?.getChildren()[0];
		const headerCount = firstCell && $isTableCellNode(firstCell) && firstCell.hasHeader() ? 1 : 0;
		const body = rows.slice(headerCount);
		const sorted = [...body].sort((a, b) => {
			const cmp = compareRowColumn(a, b, columnIndex);
			return ascending ? cmp : -cmp;
		});
		for (const row of sorted) table.append(row);
	});
}

/** Set one column's width on a table (by key), seeding the full `colWidths`
 *  array from the caller's measured per-column widths when the table has none
 *  yet. Clamped to {@link MIN_TABLE_COLUMN_WIDTH}. Used by the drag resizer. */
export function setTableColumnWidth(
	editor: LexicalEditor,
	tableKey: NodeKey,
	columnIndex: number,
	width: number,
	measuredWidths: readonly number[],
): void {
	editor.update(() => {
		const table = $getNodeByKey(tableKey);
		if (!table || !$isTableNode(table)) return;
		const existing = table.getColWidths();
		const base =
			existing && existing.length === measuredWidths.length ? [...existing] : [...measuredWidths];
		if (columnIndex < 0 || columnIndex >= base.length) return;
		base[columnIndex] = Math.max(MIN_TABLE_COLUMN_WIDTH, Math.round(width));
		table.setColWidths(base);
	});
}

/** Move the selected cell's column one position left or right, swapping it
 *  with the adjacent column in every row (and the `colWidths` entry if the
 *  table carries one). No-op at the edges. */
export function moveTableColumn(editor: LexicalEditor, toRight: boolean): void {
	editor.update(() => {
		const selection = $getSelection();
		if (!$isRangeSelection(selection)) return;
		const cell = $getTableCellNodeFromLexicalNode(selection.anchor.getNode());
		if (!$isTableCellNode(cell)) return;
		const table = cell.getParent()?.getParent();
		if (!table || !$isTableNode(table)) return;
		const from = $getTableColumnIndexFromTableCellNode(cell);
		const to = from + (toRight ? 1 : -1);
		const rows = table.getChildren().filter($isTableRowNode);
		const columnCount = rows[0]?.getChildren().length ?? 0;
		if (to < 0 || to >= columnCount) return;
		for (const row of rows) {
			const cells = row.getChildren();
			const moving = cells[from];
			const neighbor = cells[to];
			if (!moving || !neighbor) continue;
			if (toRight) neighbor.insertAfter(moving);
			else neighbor.insertBefore(moving);
		}
		const widths = table.getColWidths();
		if (widths && from < widths.length && to < widths.length) {
			const next = [...widths];
			[next[from], next[to]] = [next[to] as number, next[from] as number];
			table.setColWidths(next);
		}
	});
}

/** Copy the selected cell's text down into every cell below it in the same
 *  column (fill-down). Each target cell's content is replaced with a single
 *  paragraph carrying the source text. */
export function fillDownColumn(editor: LexicalEditor): void {
	editor.update(() => {
		const selection = $getSelection();
		if (!$isRangeSelection(selection)) return;
		const cell = $getTableCellNodeFromLexicalNode(selection.anchor.getNode());
		if (!$isTableCellNode(cell)) return;
		const row = cell.getParent();
		if (!$isTableRowNode(row)) return;
		const table = row.getParent();
		if (!table || !$isTableNode(table)) return;
		const columnIndex = $getTableColumnIndexFromTableCellNode(cell);
		const rows = table.getChildren().filter($isTableRowNode);
		const startIndex = rows.indexOf(row);
		if (startIndex < 0) return;
		const sourceText = cell.getTextContent();
		for (let r = startIndex + 1; r < rows.length; r++) {
			const target = rows[r]?.getChildren()[columnIndex];
			if (!target || !$isTableCellNode(target)) continue;
			for (const child of target.getChildren()) child.remove();
			const paragraph = $createParagraphNode();
			if (sourceText) paragraph.append($createTextNode(sourceText));
			target.append(paragraph);
		}
	});
}

function rowColumnText(row: TableRowNode, columnIndex: number): string {
	const cell = row.getChildren()[columnIndex];
	return cell ? cell.getTextContent().trim() : "";
}

function compareRowColumn(a: TableRowNode, b: TableRowNode, columnIndex: number): number {
	const ta = rowColumnText(a, columnIndex);
	const tb = rowColumnText(b, columnIndex);
	const na = Number(ta);
	const nb = Number(tb);
	if (ta !== "" && tb !== "" && !Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
	return ta.localeCompare(tb);
}

/** Resolve the TableNode the selection sits in, for both a caret
 *  (RangeSelection) and a multi-cell TableSelection. */
function currentTableNode() {
	const selection = $getSelection();
	if (!selection) return null;
	const seeds = $isRangeSelection(selection) ? [selection.anchor.getNode()] : selection.getNodes();
	for (const seed of seeds) {
		const cell = $getTableCellNodeFromLexicalNode(seed);
		const table = cell?.getParent()?.getParent();
		if (table && $isTableNode(table)) return table;
	}
	return null;
}

function pruneEmptyTables(): void {
	for (const child of $getRoot().getChildren()) {
		if ($isTableNode(child) && child.getChildrenSize() === 0) {
			const paragraph = $createParagraphNode();
			child.replace(paragraph);
		}
	}
	if ($getRoot().getChildrenSize() === 0) {
		$getRoot().append($createParagraphNode());
	}
}
