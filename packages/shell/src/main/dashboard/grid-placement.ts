/**
 * Dashboard grid placement — the single source of "where does a new
 * pinned tile land" on the MAIN side. Every install path (marketplace,
 * sideload, vault-source install, dev seeder) and every pin path
 * (dashboard-service entity pin, Bin overlay) computes its cell here.
 *
 * The geometry itself is NOT defined here: it lives in
 * `shared/dashboard-icon-grid`, which the renderer's `dashboard/grid.ts`
 * also builds on. This module is only the main-side adapter from a stored
 * icon map to that placer.
 *
 * That indirection is the POLISH-LAY-6 fix. Main used to scan a fictional
 * 12-column grid of 1×1 cells while the renderer stores 8px grid units and
 * paints an 11×14-cell footprint per icon — so with Notes at `0,0` the cell
 * `1,0` looked free and a freshly installed app's tile landed on top of it.
 *
 * Pure: same icon map → same cell.
 */

import {
	type IconGridCell,
	firstFreeIconCell,
	occupiedIconCells,
} from "../../shared/dashboard-icon-grid";

export type { IconGridCell };

/** Footprint origins already occupied by an icon, in 8px grid units. */
export function occupiedCells(icons: Record<string, { x: number; y: number }>): IconGridCell[] {
	return occupiedIconCells(icons);
}

/** First install slot (row-major, footprint-stepped) whose icon box clears
 *  every existing icon's box. */
export function firstFreeCell(occupied: readonly IconGridCell[]): IconGridCell {
	return firstFreeIconCell(occupied);
}
