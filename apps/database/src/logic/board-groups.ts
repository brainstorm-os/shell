/**
 * Board grouping helpers (9.12.28): column ordering (option rank / manual
 * drag order / item count), swimlane bucketing, and the collapse sets. Pure
 * so the board renderer and the settings popover share one tested rule.
 */

import { type BoardLayoutOptions, GroupOrderMode } from "../types/list-view";
import { groupRows, readGroupKey } from "./compile-view";
import type { EntityRow } from "./in-memory-entities";

export type BoardGroup = { key: string | null; label: string; rows: ReadonlyArray<EntityRow> };

/** `""` is the wire form of the null / "Uncategorized" group key. */
export const groupWireKey = (key: string | null): string => (key === null ? "" : key);

/** Columns in display order. The count modes sort by bucket size (stable on
 *  ties, so equal-size columns keep their option order); `Default` honours a
 *  manual `groupOrder` — listed keys first, unlisted ones after in data order
 *  so a brand-new column still appears. */
export function orderBoardGroups<G extends BoardGroup>(
	groups: ReadonlyArray<G>,
	layout: Pick<BoardLayoutOptions, "groupOrder" | "groupOrderMode">,
): G[] {
	const mode = layout.groupOrderMode ?? GroupOrderMode.Default;
	const indexed = groups.map((g, i) => ({ g, i }));
	if (mode !== GroupOrderMode.Default) {
		const sign = mode === GroupOrderMode.CountDesc ? -1 : 1;
		return indexed
			.sort((a, b) => sign * (a.g.rows.length - b.g.rows.length) || a.i - b.i)
			.map((x) => x.g);
	}
	const groupOrder = layout.groupOrder;
	if (!groupOrder || groupOrder.length === 0) return groups.slice();
	const rank = new Map(groupOrder.map((k, i) => [k, i]));
	return indexed
		.sort((a, b) => {
			const ra = rank.get(groupWireKey(a.g.key));
			const rb = rank.get(groupWireKey(b.g.key));
			if (ra !== undefined && rb !== undefined) return ra - rb;
			if (ra !== undefined) return -1;
			if (rb !== undefined) return 1;
			return a.i - b.i;
		})
		.map((x) => x.g);
}

/** True when column drag-reorder applies — a count mode owns the order. */
export function manualGroupOrderActive(
	layout: Pick<BoardLayoutOptions, "groupOrderMode">,
): boolean {
	return (layout.groupOrderMode ?? GroupOrderMode.Default) === GroupOrderMode.Default;
}

/** Swimlanes for a board: the rows bucketed by `swimlaneBy` (option rank via
 *  `orderFor`, labels via `labelFor` — the same resolvers the columns use). */
export function buildSwimlanes(
	rows: ReadonlyArray<EntityRow>,
	swimlaneBy: string,
	labelFor?: (key: string) => string | undefined,
	orderFor?: (key: string) => number | undefined,
): BoardGroup[] {
	return groupRows(rows, swimlaneBy, labelFor, orderFor);
}

/** One lane's rows split across the board's columns, keyed by the column's
 *  wire key — every column key is present (an empty cell is still a drop
 *  target). */
export function laneCells(
	laneRows: ReadonlyArray<EntityRow>,
	groupByProperty: string,
	columnKeys: ReadonlyArray<string>,
): Map<string, EntityRow[]> {
	const cells = new Map<string, EntityRow[]>(columnKeys.map((k) => [k, []]));
	for (const row of laneRows) {
		const key = groupWireKey(readGroupKey(row, groupByProperty));
		const bucket = cells.get(key);
		if (bucket) bucket.push(row);
	}
	return cells;
}

/** Toggle one key in a collapse set, returning a new array. */
export function toggleCollapsed(current: ReadonlyArray<string> | undefined, key: string): string[] {
	const set = new Set(current ?? []);
	if (set.has(key)) set.delete(key);
	else set.add(key);
	return [...set];
}

export enum CollapseAllAction {
	Collapse = "collapse",
	Expand = "expand",
}

/** The layout patch for "Collapse all" / "Expand all": lanes when the board
 *  is laned (collapsing every column of a laned board would hide every
 *  card), columns otherwise. */
export function collapseAllPatch(
	layout: Pick<BoardLayoutOptions, "swimlaneBy">,
	keys: ReadonlyArray<string>,
	action: CollapseAllAction,
): Pick<BoardLayoutOptions, "collapsedGroups"> | Pick<BoardLayoutOptions, "collapsedLanes"> {
	const next = action === CollapseAllAction.Collapse ? [...keys] : [];
	return layout.swimlaneBy ? { collapsedLanes: next } : { collapsedGroups: next };
}

/** The property patch for a card dropped into a (column, lane) cell — both
 *  axes in ONE write so the move is a single undo step. A lane-less drop or
 *  a drop into the card's own lane only writes the column property. */
export function cellMovePatch(
	entity: EntityRow,
	groupByProperty: string,
	groupKey: string | null,
	swimlaneBy: string | null | undefined,
	laneKey: string | null | undefined,
): Record<string, unknown> {
	const patch: Record<string, unknown> = {};
	if (readGroupKey(entity, groupByProperty) !== groupKey) patch[groupByProperty] = groupKey ?? "";
	if (swimlaneBy && laneKey !== undefined && readGroupKey(entity, swimlaneBy) !== laneKey) {
		patch[swimlaneBy] = laneKey ?? "";
	}
	return patch;
}
