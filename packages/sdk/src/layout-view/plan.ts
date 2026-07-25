/**
 * Layout render *plan* (Stage 8.3) — the pure half of the pipeline.
 *
 * Turns a `LayoutDef` + the entity it renders into the decisions the
 * React view then just paints: which cells survive their `condition`,
 * what order siblings sit in the DOM, and what CSS each cell + container
 * carries for its mode.
 *
 * The load-bearing rule is **DOM order is reading order**. Doc 27 makes
 * `readingOrder` the accessibility contract for `grid` / `freeform`,
 * where visual position comes from CSS and therefore says nothing about
 * traversal. Rather than paint visually and bolt an aria-order on after,
 * the plan orders the DOM by `effectiveReadingOrder` and lets CSS
 * (`grid-area`, absolute placement) move cells visually. Screen readers
 * and `Tab` then follow the contract by construction, with nothing to
 * keep in sync.
 *
 * Ordering is applied **per sibling group**, not globally flattened:
 * a `group` cell renders its children inside itself (nested modes and
 * CSS containment need that), so each container sorts its own siblings
 * by their rank in the layout's reading order. Nesting is preserved and
 * traversal within every container follows the contract.
 */

import {
	type FreeformPlacement,
	type GridPlacement,
	type LayoutCell,
	type LayoutDef,
	LayoutMode,
	effectiveReadingOrder,
} from "@brainstorm-os/sdk-types";
import type { EntityRow } from "../in-memory-entities";
import { evaluatePredicate } from "../predicate-eval";

/** Cell id → position in the layout's effective reading order. */
export function readingOrderRank(def: LayoutDef): ReadonlyMap<string, number> {
	const rank = new Map<string, number>();
	effectiveReadingOrder(def).forEach((id, index) => rank.set(id, index));
	return rank;
}

/**
 * Siblings in DOM order. Stable: cells the reading order doesn't mention
 * (it is optional for `stacked` / `grid`) keep their document position
 * relative to each other, after the ranked ones.
 */
export function orderedSiblings<T extends LayoutCell>(
	cells: readonly T[],
	rank: ReadonlyMap<string, number>,
): T[] {
	return [...cells]
		.map((cell, index) => ({ cell, index }))
		.sort((a, b) => {
			const ra = rank.get(a.cell.id);
			const rb = rank.get(b.cell.id);
			if (ra !== undefined && rb !== undefined) return ra - rb || a.index - b.index;
			if (ra !== undefined) return -1;
			if (rb !== undefined) return 1;
			return a.index - b.index;
		})
		.map((entry) => entry.cell);
}

/**
 * Does this cell's `condition` hold? Cells without one always show. The
 * predicate runs through the shared `evaluatePredicate` — the same
 * language the Database filters and `ListSource` membership use, never a
 * second mini-language (doc 27 §cells `condition`).
 */
export function isCellVisible(cell: LayoutCell, entity: EntityRow, now?: number): boolean {
	if (!cell.condition) return true;
	return evaluatePredicate(entity, cell.condition, now);
}

/** The visible siblings of one container, already in DOM order. */
export function planSiblings<T extends LayoutCell>(
	cells: readonly T[],
	entity: EntityRow,
	rank: ReadonlyMap<string, number>,
	now?: number,
): T[] {
	return orderedSiblings(
		cells.filter((cell) => isCellVisible(cell, entity, now)),
		rank,
	);
}

/** A cell's inline style for the container mode it sits in. */
export type CellStyle = {
	gridColumn?: string;
	gridRow?: string;
	position?: "absolute";
	left?: string;
	top?: string;
	width?: string;
	height?: string;
	transform?: string;
};

function gridSpan(start: number, span: number | undefined): string {
	const size = span && span > 1 ? span : 1;
	return size > 1 ? `${start} / span ${size}` : String(start);
}

function gridStyle(placement: GridPlacement): CellStyle {
	return {
		gridColumn: gridSpan(placement.col, placement.colSpan),
		gridRow: gridSpan(placement.row, placement.rowSpan),
	};
}

function freeformStyle(placement: FreeformPlacement): CellStyle {
	return {
		position: "absolute",
		left: `${placement.x}px`,
		top: `${placement.y}px`,
		width: `${placement.width}px`,
		height: `${placement.height}px`,
		...(placement.rotation ? { transform: `rotate(${placement.rotation}deg)` } : {}),
	};
}

/**
 * Positioning for one cell. `stacked` reads order from the DOM and needs
 * no per-cell style; `grid` and `freeform` read the cell's placement for
 * that mode. A cell missing the placement its container's mode wants
 * falls back to flow position rather than collapsing to `0,0` — a
 * half-authored layout stays legible instead of stacking everything in
 * the top-left corner.
 */
export function cellStyle(cell: LayoutCell, mode: LayoutMode): CellStyle {
	if (mode === LayoutMode.Grid && cell.grid) return gridStyle(cell.grid);
	if (mode === LayoutMode.Freeform && cell.freeform) return freeformStyle(cell.freeform);
	return {};
}

/** The mode a `group` cell's children render in — its own if it declares
 *  one (doc 27: nested composition), else the container's. */
export function groupMode(cell: { mode?: LayoutMode }, parentMode: LayoutMode): LayoutMode {
	return cell.mode ?? parentMode;
}

/** The container class for a mode. The CSS owns the flex / grid / canvas
 *  boxes so a consumer never hand-rolls layout geometry. */
export function containerClass(mode: LayoutMode): string {
	switch (mode) {
		case LayoutMode.Grid:
			return "bs-layout bs-layout--grid";
		case LayoutMode.Freeform:
			return "bs-layout bs-layout--freeform";
		default:
			return "bs-layout bs-layout--stacked";
	}
}

/**
 * The freeform canvas's content box — the extent of its placed cells, so
 * the host can size / scroll it. `null` when nothing is placed.
 */
export function freeformExtent(
	cells: readonly LayoutCell[],
): { width: number; height: number } | null {
	let width = 0;
	let height = 0;
	let seen = false;
	for (const cell of cells) {
		if (!cell.freeform) continue;
		seen = true;
		width = Math.max(width, cell.freeform.x + cell.freeform.width);
		height = Math.max(height, cell.freeform.y + cell.freeform.height);
	}
	return seen ? { width, height } : null;
}
