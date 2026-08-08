/**
 * List-mode column model (9.8.11): which trailing columns the folder list
 * shows, in order. The chooser toggles a column off in place and appends a
 * re-enabled one at the end, so the stored order IS the user's chosen
 * order (no separate drag-reorder surface — the list has no column headers
 * to drag; revisit if it grows them).
 */

export enum ListColumn {
	Kind = "kind",
	Modified = "modified",
	Size = "size",
}

export const ALL_LIST_COLUMNS: readonly ListColumn[] = [
	ListColumn.Kind,
	ListColumn.Modified,
	ListColumn.Size,
];

export const DEFAULT_LIST_COLUMNS: readonly ListColumn[] = [ListColumn.Kind, ListColumn.Modified];

export function isListColumn(value: unknown): value is ListColumn {
	return typeof value === "string" && (ALL_LIST_COLUMNS as readonly string[]).includes(value);
}

/** Defensive parse of a stored column order: keep valid, de-duplicated
 *  entries in stored order; anything unusable degrades to the default set. */
export function parseListColumns(raw: unknown): readonly ListColumn[] {
	if (!Array.isArray(raw)) return DEFAULT_LIST_COLUMNS;
	const out: ListColumn[] = [];
	for (const value of raw) {
		if (isListColumn(value) && !out.includes(value)) out.push(value);
	}
	return out;
}

/** Toggle a column: present → removed in place; absent → appended (the
 *  insertion order is the render order). */
export function toggleListColumn(columns: readonly ListColumn[], column: ListColumn): ListColumn[] {
	return columns.includes(column) ? columns.filter((c) => c !== column) : [...columns, column];
}

/** Grid-track width per column — the row builds its list-mode
 *  `grid-template-columns` from the visible set. */
export const LIST_COLUMN_WIDTH: Record<ListColumn, string> = {
	[ListColumn.Kind]: "minmax(0, 160px)",
	[ListColumn.Modified]: "120px",
	[ListColumn.Size]: "88px",
};

/**
 * The list-mode icon track, decided ONCE for a whole folder.
 *
 * `grid-template-columns` is a per-ROW declaration — each row is its own grid —
 * so an `auto` leading track sizes independently per row. A row renders an
 * empty icon span when its entity has no icon (the project-wide
 * no-default-type-icon-fallback rule), which collapsed the track to 0 on those
 * rows while icon-bearing rows reserved it. The result was two column
 * geometries in one list: name, kind and modified each landing at two
 * different x positions.
 *
 * `anyRowHasIcon` therefore has to be computed across the folder, not per row.
 * The fallback rule survives: a folder where NOTHING has an icon still yields a
 * zero track, so every name slides left into the slot.
 */
export function listIconTrack(anyRowHasIcon: boolean, iconSizePx: number): string {
	return anyRowHasIcon ? `${iconSizePx}px` : "0px";
}
