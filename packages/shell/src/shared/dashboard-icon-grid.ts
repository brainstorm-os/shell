/**
 * Dashboard icon-grid placement geometry — the ONE model of "what does a
 * stored icon `{x, y}` mean, and where does a newly installed tile land".
 *
 * Pure (no Electron / React / DOM) so the renderer, main and preload share it.
 *
 * Stored `{x, y}` are counts of `GRID_UNIT` (8px) cells, NOT column indices:
 * an icon's visual box spans `ICON_FOOTPRINT_W` × `ICON_FOOTPRINT_H` cells, so
 * the seeded fleet reads `0,0 · 11,0 · 22,0 … 0,14`. Main used to place new
 * tiles by scanning a fictional 12-column grid of 1×1 cells, which made cell
 * `1,0` look free while Notes' 11×14 footprint was sitting on it — a freshly
 * installed app landed ON TOP of Notes (POLISH-LAY-6). Both sides now compute
 * the slot from this module, so there is no second implementation to drift.
 */

export type IconGridCell = { col: number; row: number };

export const GRID_UNIT = 8;

/** Fixed icon-button box (tile + two label lines). Keep in lockstep with
 *  `--grid-icon-w/-h` in `renderer/dashboard/icons-layer.css`. */
export const ICON_BUTTON_W = 80;
export const ICON_BUTTON_H = 104;

/** Footprint of one icon, in `GRID_UNIT` cells (button box + a 1-cell gutter) —
 *  the slot spacing the install placer steps by, and the box it checks for
 *  overlap. Free drags ignore this; only new installs avoid piling. */
export const ICON_FOOTPRINT_W = Math.ceil(ICON_BUTTON_W / GRID_UNIT) + 1;
export const ICON_FOOTPRINT_H = Math.ceil(ICON_BUTTON_H / GRID_UNIT) + 1;

/** Bound on the install scan. A dashboard can't hold anywhere near this many
 *  icons; it exists only so a pathological store can't spin forever. */
const MAX_SLOT_SCAN = 1024;

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

/** First free install slot: scan footprint-stepped slots (row-major) for one
 *  whose footprint clears every occupied icon. New installs land in a tidy grid;
 *  the user can then freely drag them anywhere on the 8px grid. */
export function firstFreeIconCell(occupied: readonly IconGridCell[]): IconGridCell {
	for (let r = 0; r < MAX_SLOT_SCAN; r++) {
		for (let c = 0; c < MAX_SLOT_SCAN; c++) {
			const slot = { col: c * ICON_FOOTPRINT_W, row: r * ICON_FOOTPRINT_H };
			if (!occupied.some((o) => footprintsOverlap(slot, o))) return slot;
		}
	}
	return { col: 0, row: MAX_SLOT_SCAN * ICON_FOOTPRINT_H };
}

/** The cells a stored icon map occupies, as footprint origins. Non-finite /
 *  fractional records (legacy pixel writes, rare) are floored rather than
 *  dropped — a dropped record is a record the placer will happily land on. */
export function occupiedIconCells(
	icons: Readonly<Record<string, { x: number; y: number }>>,
): IconGridCell[] {
	const cells: IconGridCell[] = [];
	for (const icon of Object.values(icons)) {
		if (!Number.isFinite(icon.x) || !Number.isFinite(icon.y)) continue;
		cells.push({ col: Math.max(0, Math.floor(icon.x)), row: Math.max(0, Math.floor(icon.y)) });
	}
	return cells;
}
