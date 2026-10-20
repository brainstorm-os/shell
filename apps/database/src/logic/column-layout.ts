/**
 * Column placement + presentation rules (9.12.29). The synthetic Name column
 * (`__title__`) is an ordinary, reorderable column: a view that never moved
 * it carries no entry and Name renders first; once the user drags it, the
 * entry is persisted in `view.columns` at its position. Non-grid consumers
 * (cards, list rows, export) read `propertyColumns` and never see it.
 */

import { type ColumnSpec, ColumnWrap } from "../types/list-view";

export const TITLE_COLUMN_ID = "__title__";

const TITLE_SPEC: ColumnSpec = { propertyId: TITLE_COLUMN_ID, visible: true };

/** `columns` with the Name column present — kept where the view placed it,
 *  else prepended. */
export function withTitleColumn(columns: ReadonlyArray<ColumnSpec>): ColumnSpec[] {
	return columns.some((c) => c.propertyId === TITLE_COLUMN_ID)
		? columns.slice()
		: [TITLE_SPEC, ...columns];
}

/** `columns` without the Name placeholder — the property columns every
 *  card / list / export surface iterates. */
export function propertyColumns(columns: ReadonlyArray<ColumnSpec>): ColumnSpec[] {
	return columns.filter((c) => c.propertyId !== TITLE_COLUMN_ID);
}

/** Patch one column by id over the title-inclusive column list, so a resize /
 *  alias / wrap change on Name persists like any other column's. */
export function patchColumn(
	columns: ReadonlyArray<ColumnSpec>,
	propertyId: string,
	patch: Partial<ColumnSpec>,
): ColumnSpec[] {
	const base = propertyId === TITLE_COLUMN_ID ? withTitleColumn(columns) : columns.slice();
	return base.map((c) => (c.propertyId === propertyId ? { ...c, ...patch } : c));
}

/** Drop the optional presentation keys whose value is the default, so a
 *  cleared alias / wrap leaves no residue on the persisted spec. */
export function setColumnPresentation(
	columns: ReadonlyArray<ColumnSpec>,
	propertyId: string,
	patch: { label?: string | null; iconOnly?: boolean; wrap?: ColumnWrap | null },
): ColumnSpec[] {
	const base = propertyId === TITLE_COLUMN_ID ? withTitleColumn(columns) : columns.slice();
	return base.map((c) => {
		if (c.propertyId !== propertyId) return c;
		const { label: oldLabel, iconOnly: oldIconOnly, wrap: oldWrap, ...rest } = c;
		const label = "label" in patch ? patch.label?.trim() : oldLabel;
		const iconOnly = "iconOnly" in patch ? patch.iconOnly : oldIconOnly;
		const wrap = "wrap" in patch ? patch.wrap : oldWrap;
		return {
			...rest,
			...(label ? { label } : {}),
			...(iconOnly ? { iconOnly: true } : {}),
			...(wrap ? { wrap } : {}),
		};
	});
}

/** Whether a column's cells wrap: its own override, else the view setting. */
export function columnWraps(column: ColumnSpec, viewWrap: boolean): boolean {
	if (column.wrap === ColumnWrap.Wrap) return true;
	if (column.wrap === ColumnWrap.NoWrap) return false;
	return viewWrap;
}

/** The header label: the per-view alias, else the resolved name. */
export function columnHeaderLabel(column: ColumnSpec, resolvedName: string): string {
	return column.label?.trim() ? column.label : resolvedName;
}
