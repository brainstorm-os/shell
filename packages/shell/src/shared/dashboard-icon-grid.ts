/**
 * Dashboard icon-grid placement geometry — the ONE model of "what does a
 * stored icon `{x, y}` mean, and where does a newly installed tile land".
 *
 * Pure (no Electron / React / DOM) so the renderer, main and preload share it.
 *
 * Stored `{x, y}` are counts of `GRID_UNIT` (8px) cells, NOT column indices:
 * an icon's visual box spans `ICON_FOOTPRINT_W` × `ICON_FOOTPRINT_H` cells, so
 * a wrapped fleet reads `0,0 · 11,0 · 22,0 … 0,14`.
 *
 * **Who places an icon (POLISH-LAY-9).** The RENDERER does. Placement needs a
 * column bound, a column bound needs the surface width, and the surface width
 * is something only the renderer knows (main's window bounds are not the icon
 * surface). Main used to call the placer itself with no bound at all, so the
 * install slot marched along one unbounded row: on the captured 20-app fleet
 * (`0,0 · 11,0 … 209,0`) the next install landed at `220,0` = 1760px on a
 * 1440px stage — off the edge of a surface that does not scroll sideways, i.e.
 * permanently unreachable. Main now writes `UNPLACED_ICON_POSITION` and the
 * renderer resolves it against its real viewport via `resolveIconPlacements`,
 * then persists the result.
 *
 * The geometry stays here (that was #369's point — one footprint/overlap/scan
 * model, no second implementation to drift); what moved is only *who calls it
 * and with what column bound*.
 */

export type IconGridCell = { col: number; row: number };

export const GRID_UNIT = 8;

/** Padding between the icon surface's edge and the first icon box. */
export const GRID_OUTER_MARGIN = 16;

/** Fixed icon-button box (tile + two label lines). Keep in lockstep with
 *  `--grid-icon-w/-h` in `renderer/dashboard/icons-layer.css`. */
export const ICON_BUTTON_W = 80;
export const ICON_BUTTON_H = 104;

/** Footprint of one icon, in `GRID_UNIT` cells (button box + a 1-cell gutter) —
 *  the slot spacing the install placer steps by, and the box it checks for
 *  overlap. Free drags ignore this; only new installs avoid piling. */
export const ICON_FOOTPRINT_W = Math.ceil(ICON_BUTTON_W / GRID_UNIT) + 1;
export const ICON_FOOTPRINT_H = Math.ceil(ICON_BUTTON_H / GRID_UNIT) + 1;

/** Bound on the install scan's ROW axis (columns are bounded by the viewport).
 *  A dashboard can't hold anywhere near this many rows; it exists only so a
 *  pathological store can't spin forever. */
const MAX_ROW_SCAN = 1024;

/**
 * The `{x, y}` main writes for an icon it installs or pins: "no position yet —
 * renderer, place this". A negative coordinate is unambiguous (every real cell
 * is ≥ 0) and, unlike a `0,0` seed, can never be mistaken for a deliberate
 * top-left placement.
 */
export const UNPLACED_ICON_COORD = -1;
export const UNPLACED_ICON_POSITION: { x: number; y: number } = {
	x: UNPLACED_ICON_COORD,
	y: UNPLACED_ICON_COORD,
};

/** Does this stored record still need the renderer to choose a cell for it?
 *  Any negative or non-finite coordinate counts — a corrupt record is better
 *  re-placed than pinned to the origin under whatever sits there. */
export function isUnplacedIcon(icon: { x: number; y: number }): boolean {
	return !Number.isFinite(icon.x) || !Number.isFinite(icon.y) || icon.x < 0 || icon.y < 0;
}

/** How many footprint-wide install columns fit on a `surfaceWidthPx`-wide icon
 *  surface. Clamped to ≥ 1: a window too narrow for even one icon still gets a
 *  single column (icons overhang rather than vanishing into a zero-wide grid). */
export function iconGridColumns(surfaceWidthPx: number): number {
	const usable = surfaceWidthPx - 2 * GRID_OUTER_MARGIN;
	return Math.max(1, Math.floor(usable / (ICON_FOOTPRINT_W * GRID_UNIT)));
}

/** Rightmost origin cell whose whole icon box still fits inside a
 *  `surfaceWidthPx`-wide surface. Drops clamp to this (`pointToCell`), and
 *  anything stored beyond it is horizontally unreachable. */
export function maxIconCol(surfaceWidthPx: number): number {
	return Math.max(0, Math.floor((surfaceWidthPx - GRID_OUTER_MARGIN - ICON_BUTTON_W) / GRID_UNIT));
}

/** Do two icon footprints (top-left cells `a`, `b`, each `ICON_FOOTPRINT_W` ×
 *  `ICON_FOOTPRINT_H`) overlap? Used only to place a NEW icon clear of existing
 *  ones — user drags are free and never overlap-checked. */
export function footprintsOverlap(a: IconGridCell, b: IconGridCell): boolean {
	return (
		a.col < b.col + ICON_FOOTPRINT_W &&
		b.col < a.col + ICON_FOOTPRINT_W &&
		a.row < b.row + ICON_FOOTPRINT_H &&
		b.row < a.row + ICON_FOOTPRINT_H
	);
}

/** First free install slot within `columns`: scan footprint-stepped slots
 *  (row-major, wrapping at the column bound) for one whose footprint clears
 *  every occupied icon. New installs land in a tidy grid that stays on-screen;
 *  the user can then freely drag them anywhere on the 8px grid.
 *
 *  `columns` is REQUIRED — an unbounded scan is the POLISH-LAY-9 bug. */
export function firstFreeIconCell(
	occupied: readonly IconGridCell[],
	columns: number,
): IconGridCell {
	const cols = Math.max(1, Math.floor(columns));
	for (let r = 0; r < MAX_ROW_SCAN; r++) {
		for (let c = 0; c < cols; c++) {
			const slot = { col: c * ICON_FOOTPRINT_W, row: r * ICON_FOOTPRINT_H };
			if (!occupied.some((o) => footprintsOverlap(slot, o))) return slot;
		}
	}
	return { col: 0, row: MAX_ROW_SCAN * ICON_FOOTPRINT_H };
}

/** The cells a stored icon map occupies, as footprint origins. Unplaced records
 *  contribute nothing — they have no cell yet, and reading their sentinel as
 *  the origin would block the very slot they are about to be given. */
export function occupiedIconCells(
	icons: Readonly<Record<string, { x: number; y: number }>>,
): IconGridCell[] {
	const cells: IconGridCell[] = [];
	for (const icon of Object.values(icons)) {
		if (isUnplacedIcon(icon)) continue;
		cells.push({ col: Math.floor(icon.x), row: Math.floor(icon.y) });
	}
	return cells;
}

/** Why the renderer chose a cell for an icon. `Unplaced` is a real placement
 *  decision and is persisted; `Offscreen` is a view-model rescue only. */
export enum IconPlacementReason {
	/** The record carried no position (main deferred to the renderer). */
	Unplaced = "unplaced",
	/** The stored cell puts the icon's box past the surface's right edge, so it
	 *  is unreachable at this width. */
	Offscreen = "offscreen",
}

export type IconPlacementChange = {
	id: string;
	col: number;
	row: number;
	reason: IconPlacementReason;
};

/**
 * Resolve cells for every icon that hasn't got a usable one on a
 * `surfaceWidthPx`-wide surface. Icons with an on-screen stored cell are left
 * alone (free placement — the user owns the layout) and count as occupied; the
 * rest are filled into free footprint slots that wrap at the column bound.
 *
 * Two kinds of change come back, and the caller treats them differently:
 *
 * - `Unplaced` — freshly installed/pinned, no position at all. Persist it: the
 *   record needs a real cell, and this is the live install reveal.
 * - `Offscreen` — stored past the right edge (a fleet placed when the window
 *   was wider, or by the pre-POLISH-LAY-9 unbounded placer). Apply it to the
 *   VIEW-MODEL only, never eagerly to the store — mirroring `clampWidgetOrigin`
 *   (F-379). Widening the window must restore the user's own arrangement, so a
 *   narrow window may not quietly rewrite it; touching a rescued icon (drag)
 *   persists its new spot through the normal path.
 *
 * Deterministic: same map + same width ⇒ same result, and idempotent — feeding
 * back a resolved layout returns no changes. Assignment order is the map's own
 * key order, so a batch-seeded fleet keeps its seed order.
 */
export function resolveIconPlacements(
	icons: Readonly<Record<string, { x: number; y: number }>>,
	surfaceWidthPx: number,
): IconPlacementChange[] {
	if (!Number.isFinite(surfaceWidthPx) || surfaceWidthPx <= 0) return [];
	const columns = iconGridColumns(surfaceWidthPx);
	const maxCol = maxIconCol(surfaceWidthPx);
	const occupied: IconGridCell[] = [];
	const needy: { id: string; reason: IconPlacementReason }[] = [];
	for (const [id, icon] of Object.entries(icons)) {
		if (isUnplacedIcon(icon)) {
			needy.push({ id, reason: IconPlacementReason.Unplaced });
			continue;
		}
		const cell = { col: Math.floor(icon.x), row: Math.floor(icon.y) };
		if (cell.col > maxCol) {
			needy.push({ id, reason: IconPlacementReason.Offscreen });
			continue;
		}
		occupied.push(cell);
	}
	const changes: IconPlacementChange[] = [];
	for (const { id, reason } of needy) {
		const cell = firstFreeIconCell(occupied, columns);
		occupied.push(cell);
		changes.push({ id, col: cell.col, row: cell.row, reason });
	}
	return changes;
}
