/**
 * Dashboard icon grid math. The dashboard reads as a "desktop OS": icons snap
 * to a FIXED `GRID_UNIT`px grid (8px) and placement is FREE — an icon lands
 * exactly where it's dropped (snapped to 8px) and keeps that spot; overlap is
 * allowed. Positions are absolute pixel offsets (an icon stays put across window
 * resizes, like a real desktop), NOT proportional cell indices.
 *
 * Storage format: `{x, y}` are counts of `GRID_UNIT` cells (so `x*8 + margin` is
 * the pixel left). Pre-8px vaults stored coarse 14-column cell indices (`x` in
 * 0..13); a layout where EVERY icon sits within `LEGACY_GRID_MAX` is detected as
 * old-format and re-packed once onto the 8px grid by the icons-layer (the
 * arrangement reshuffles once — chosen migration). A populated 8px layout spreads
 * past that bound immediately (install slots step by `ICON_FOOTPRINT_W`).
 *
 * Bounds: columns/rows are clamped to ≥ 0 only (a drop is clamped to keep the
 * icon on-screen via `pointToCell`, which shares its right-edge bound with the
 * placer through `maxIconCol`). There is NO collision resolution — see
 * `layoutIcons`. Where a NEW icon lands, and who decides, is
 * `resolveIconPlacements` + the icons-layer (POLISH-LAY-9).
 */

import {
	GRID_OUTER_MARGIN,
	GRID_UNIT,
	ICON_BUTTON_H,
	ICON_BUTTON_W,
	ICON_FOOTPRINT_H,
	ICON_FOOTPRINT_W,
	isUnplacedIcon,
	maxIconCol,
} from "../../shared/dashboard-icon-grid";

/** The placement geometry lives in `shared/dashboard-icon-grid` — one
 *  footprint/overlap/scan model (POLISH-LAY-6), now called with a viewport-
 *  derived column bound by the renderer alone (POLISH-LAY-9). Re-exported here
 *  so every existing renderer call site keeps importing from `./grid`. */
export {
	GRID_OUTER_MARGIN,
	GRID_UNIT,
	ICON_BUTTON_W,
	ICON_BUTTON_H,
	ICON_FOOTPRINT_W,
	ICON_FOOTPRINT_H,
	IconPlacementReason,
	type IconPlacementChange,
	iconGridColumns,
	isUnplacedIcon,
	maxIconCol,
	resolveIconPlacements,
	UNPLACED_ICON_POSITION,
} from "../../shared/dashboard-icon-grid";

/** A layout whose every icon sits within this many cells of the origin is a
 *  pre-8px (coarse 14-col) layout to re-pack once. New 8px layouts spread past
 *  it after the first couple of installs. */
export const LEGACY_GRID_MAX = 16;

export type GridCell = { col: number; row: number };
export type GridPoint = { x: number; y: number };
export type GridBounds = { cols: number; rows: number };
export type GridSize = { w: number; h: number };

/** The fixed cell size. Viewport-independent now (8px square); the argument is
 *  kept so existing call sites compile unchanged. */
export function getCellSize(_viewport?: GridPoint): GridSize {
	return { w: GRID_UNIT, h: GRID_UNIT };
}

/** Icon visual dimensions. Now FIXED (no longer derived from the cell): on a
 *  fixed 8px grid the icon is a stable pixel size regardless of window size. The
 *  `cell` argument is ignored, kept for call-site compatibility. */
export type IconSize = { w: number; h: number; tile: number };

/** Inner tile of the icon button. The button box itself (`ICON_BUTTON_W/H`) and
 *  its footprint come from the shared placement module re-exported above; keep
 *  all three in lockstep with `--grid-icon-w/-h` + the tile size in
 *  `icons-layer.css`. */
export const ICON_TILE = 56;

/**
 * Vertical slot reserved *below the tile, above the label* by every icon
 * variant. The app tile fills it with the running-state dot
 * (`.app-icon__dot`: 4px dot + 2px margin-top); the pinned-object tile
 * fills it with an empty spacer of the same height. This is the single
 * source of truth for that reserve — both variants must use it so the
 * icon→label distance is pixel-identical regardless of which tile renders.
 * Keep in lockstep with `.app-icon__dot` in `app-icon.css`.
 */
export const ICON_DOT_RESERVE_PX = 6;

/**
 * Optical inset for a pinned object's own icon (emoji / pack glyph /
 * image) inside its `tile`-square box. App squircle artwork carries large
 * built-in internal padding (the COCO glyph is ~31% of its canvas), so an
 * emoji image — which fills its bounding box edge-to-edge — reads far
 * bigger than an app glyph in the same-size box unless it's inset. The
 * resolved glyph is sized at `tile * ICON_PIN_GLYPH_RATIO` and centred, so
 * a pinned emoji carries the same optical weight as a sibling app glyph.
 */
export const ICON_PIN_GLYPH_RATIO = 0.74;

export function getIconSize(_cell?: GridSize): IconSize {
	return { w: ICON_BUTTON_W, h: ICON_BUTTON_H, tile: ICON_TILE };
}

export function cellToPoint(cell: GridCell, _viewport?: GridPoint): GridPoint {
	return {
		x: GRID_OUTER_MARGIN + cell.col * GRID_UNIT,
		y: GRID_OUTER_MARGIN + cell.row * GRID_UNIT,
	};
}

/** Snap a surface point to the nearest 8px cell. `col` is clamped so the icon's
 *  box stays on-screen for the given viewport (a drop near the right/bottom edge
 *  doesn't push the icon off); both axes clamp at 0. */
export function pointToCell(point: GridPoint, viewport: GridPoint): GridCell {
	const col = Math.round((point.x - GRID_OUTER_MARGIN) / GRID_UNIT);
	const row = Math.round((point.y - GRID_OUTER_MARGIN) / GRID_UNIT);
	const maxCol = maxIconCol(viewport.x);
	const maxRow = Math.max(
		0,
		Math.floor((viewport.y - GRID_OUTER_MARGIN - ICON_BUTTON_H) / GRID_UNIT),
	);
	return {
		col: Math.max(0, Math.min(col, maxCol)),
		row: Math.max(0, Math.min(row, maxRow)),
	};
}

export function clampCell(cell: GridCell): GridCell {
	return { col: Math.max(0, Math.floor(cell.col)), row: Math.max(0, Math.floor(cell.row)) };
}

// --- Widget grid (Stage 7.3 / 7.3b) ---
//
// Widgets sit on their OWN fixed 8px grid (NOT the proportional icon grid), so
// they place + resize finely and at a stable pixel size regardless of window
// size. `x`/`y`/`w`/`h` in a `WidgetRecord` are counts of `WIDGET_UNIT`px cells.
// This grid is independent of the icon collision system.

/** The widget snap unit, in pixels. Drag + resize both snap to this. */
export const WIDGET_UNIT = 8;

/** Floor on a widget's footprint, in `WIDGET_UNIT` cells (≈ 64×48px). */
export const WIDGET_MIN_W = 8;
export const WIDGET_MIN_H = 6;

/** Pre-7.3b widgets stored `w`/`h` as icon-grid cells (Small = 2×2, …). One old
 *  ~80px cell is ~10 units, so a stored footprint below this many cells is a
 *  legacy record to scale up (×`OLD_WIDGET_CELL_TO_UNIT`). Self-terminating: the
 *  smallest 8px footprint is `WIDGET_MIN_W` (8) ≥ this, so a migrated record is
 *  never re-migrated. */
export const LEGACY_WIDGET_MAX_CELL = 6;
export const OLD_WIDGET_CELL_TO_UNIT = 10;

/** Widget size enum — the manifest/registry value set. String values ARE the
 *  wire format (registry `widgets.size` column), so they double as the union. */
export enum WidgetSize {
	Small = "small",
	Medium = "medium",
	Large = "large",
}

/** Default footprint per widget size, in `WIDGET_UNIT` cells. Small ≈ 160px
 *  square glance tile; medium a wide row; large a panel. A user resize overrides
 *  this on the stored record; a freshly-placed widget takes its size's default. */
export function widgetFootprint(size: WidgetSize): GridSize {
	switch (size) {
		case WidgetSize.Small:
			return { w: 20, h: 20 };
		case WidgetSize.Medium:
			return { w: 40, h: 20 };
		case WidgetSize.Large:
			return { w: 40, h: 40 };
	}
}

/**
 * Which preset a stored footprint corresponds to, or `null` for a size the
 * user made themselves (F-462).
 *
 * The presets are not the whole space: the resize grip writes arbitrary w/h
 * in `WIDGET_UNIT` steps, so most real widgets match none of the three. A
 * "pick one of three" menu therefore cannot just mark the matching row — it
 * has to be able to say "none of these", which is what `null` is for. Note
 * Small and Medium share a height and Medium and Large share a width, so the
 * match must compare BOTH axes.
 */
export function matchedWidgetSize(footprint: GridSize): WidgetSize | null {
	for (const size of [WidgetSize.Small, WidgetSize.Medium, WidgetSize.Large]) {
		const fp = widgetFootprint(size);
		if (footprint.w === fp.w && footprint.h === fp.h) return size;
	}
	return null;
}

/** Migrate one stored widget record onto the 8px grid. A pre-7.3b record (tiny
 *  icon-grid footprint) is scaled up so it keeps roughly its on-screen size +
 *  position; an already-8px record is returned unchanged. Width alone is the
 *  discriminator: every current-format record has `w ≥ WIDGET_MIN_W (8) >
 *  LEGACY_WIDGET_MAX_CELL`, but `WIDGET_MIN_H (6)` is NOT above the legacy
 *  ceiling — testing height too made a widget resized to minimum height
 *  re-enter the migration and teleport ×10 (F-323). */
export function migrateWidgetRecord<T extends { x: number; y: number; w: number; h: number }>(
	record: T,
): T {
	if (record.w > LEGACY_WIDGET_MAX_CELL) return record;
	return {
		...record,
		x: Math.max(0, Math.round(record.x)) * OLD_WIDGET_CELL_TO_UNIT,
		y: Math.max(0, Math.round(record.y)) * OLD_WIDGET_CELL_TO_UNIT,
		w: Math.max(1, Math.round(record.w)) * OLD_WIDGET_CELL_TO_UNIT,
		h: Math.max(1, Math.round(record.h)) * OLD_WIDGET_CELL_TO_UNIT,
	};
}

/** Highest origin cell that still leaves `minCells` widget cells between the
 *  origin and the surface edge (`surfacePx` wide/tall). */
function maxWidgetOriginCell(surfacePx: number, minCells: number): number {
	return Math.floor((surfacePx - GRID_OUTER_MARGIN) / WIDGET_UNIT) - minCells;
}

/** Clamp a widget's stored origin so its WHOLE footprint stays inside the
 *  working area: the card's top-left is pulled in far enough that `origin + w/h`
 *  never spills past the surface edge (no card is draggable/placeable partly
 *  off-screen). When the record carries no size we fall back to the minimum
 *  footprint (`WIDGET_MIN_W`×`WIDGET_MIN_H`). Also rescues records stranded
 *  off-surface — the F-379 ×10 teleport baked origins like row 500 (≈4000px
 *  below an 800px fold) into the store, and nothing ever pulled them back, so
 *  the widget was unreachable forever. Position-only (`w`/`h` untouched);
 *  identity-preserving when already fully on-surface; a zero/unknown surface
 *  clamps nothing (pre-layout mount must not yank every card to the origin). A
 *  card larger than the surface floors at the origin (0,0) and overhangs the
 *  far edge — unavoidable, but its grips stay reachable. */
export function clampWidgetOrigin<T extends { x: number; y: number; w?: number; h?: number }>(
	record: T,
	surface: GridPoint,
): T {
	if (surface.x <= 0 || surface.y <= 0) return record;
	const spanW = typeof record.w === "number" ? Math.max(WIDGET_MIN_W, record.w) : WIDGET_MIN_W;
	const spanH = typeof record.h === "number" ? Math.max(WIDGET_MIN_H, record.h) : WIDGET_MIN_H;
	const x = Math.max(0, Math.min(record.x, maxWidgetOriginCell(surface.x, spanW)));
	const y = Math.max(0, Math.min(record.y, maxWidgetOriginCell(surface.y, spanH)));
	if (x === record.x && y === record.y) return record;
	return { ...record, x, y };
}

/** Does a widget record overlap any placed app icon?
 *
 * Widgets and icons share ONE coordinate system — both are
 * `GRID_OUTER_MARGIN + cell * unit` from the same origin, and `WIDGET_UNIT`
 * equals `GRID_UNIT` — so the comparison is a direct pixel-rect intersection.
 * Nothing reconciled them before, which is how a widget came to render on top
 * of the app icon row (found by the 327 screenshot audit). */
export function widgetOverlapsIcons(
	widget: { x: number; y: number; w?: number; h?: number },
	icons: readonly { x: number; y: number }[],
): boolean {
	const wx = GRID_OUTER_MARGIN + widget.x * WIDGET_UNIT;
	const wy = GRID_OUTER_MARGIN + widget.y * WIDGET_UNIT;
	const ww = Math.max(WIDGET_MIN_W, widget.w ?? WIDGET_MIN_W) * WIDGET_UNIT;
	const wh = Math.max(WIDGET_MIN_H, widget.h ?? WIDGET_MIN_H) * WIDGET_UNIT;
	return icons.some((icon) => {
		if (isUnplacedIcon(icon)) return false;
		const ix = GRID_OUTER_MARGIN + icon.x * GRID_UNIT;
		const iy = GRID_OUTER_MARGIN + icon.y * GRID_UNIT;
		return (
			wx < ix + ICON_FOOTPRINT_W * GRID_UNIT &&
			wx + ww > ix &&
			wy < iy + ICON_FOOTPRINT_H * GRID_UNIT &&
			wy + wh > iy
		);
	});
}

/** Move a widget DOWN until it clears every icon, then re-clamp to the surface.
 *
 * Down rather than sideways because that is the dashboard's actual shape: icons
 * band across the top, widgets live beneath them. A widget already clear is
 * returned untouched (identity preserved, so the caller's `changed` check still
 * works). If no clear row exists within the surface the record is returned as
 * clamped — never dropped; an invisible widget is worse than an overlapping
 * one. */
export function rescueWidgetFromIcons<T extends { x: number; y: number; w?: number; h?: number }>(
	record: T,
	icons: readonly { x: number; y: number }[],
	surface: GridPoint,
): T {
	if (icons.length === 0 || !widgetOverlapsIcons(record, icons)) return record;
	const spanH = Math.max(WIDGET_MIN_H, record.h ?? WIDGET_MIN_H);
	const maxRow = maxWidgetOriginCell(surface.y, spanH);
	for (let row = record.y + 1; row <= maxRow; row += 1) {
		const candidate = { ...record, y: row };
		if (!widgetOverlapsIcons(candidate, icons)) return candidate;
	}
	return record;
}

/** Snap a window-content point to the nearest widget cell (origin-relative). */
export function widgetPointToCell(point: GridPoint): GridCell {
	return {
		col: Math.max(0, Math.round((point.x - GRID_OUTER_MARGIN) / WIDGET_UNIT)),
		row: Math.max(0, Math.round((point.y - GRID_OUTER_MARGIN) / WIDGET_UNIT)),
	};
}

/** Clamp a resized footprint to the widget floor (in cells). */
export function clampWidgetSize(size: GridSize): GridSize {
	return {
		w: Math.max(WIDGET_MIN_W, Math.round(size.w)),
		h: Math.max(WIDGET_MIN_H, Math.round(size.h)),
	};
}

/** Clamp a footprint to both the widget floor AND the working area: a card
 *  resized/grown from a FIXED origin cell can't spill past the surface edge
 *  (the origin stays put, only the size is capped — so the corner the user
 *  isn't dragging doesn't jump). A zero/unknown surface caps nothing. The floor
 *  wins if the origin sits closer to the edge than the minimum footprint. */
export function clampWidgetSizeToSurface(
	origin: GridCell,
	size: GridSize,
	surface: GridPoint,
): GridSize {
	const floored = clampWidgetSize(size);
	if (surface.x <= 0 || surface.y <= 0) return floored;
	const maxW = Math.floor((surface.x - GRID_OUTER_MARGIN) / WIDGET_UNIT) - origin.col;
	const maxH = Math.floor((surface.y - GRID_OUTER_MARGIN) / WIDGET_UNIT) - origin.row;
	return {
		w: Math.max(WIDGET_MIN_W, Math.min(floored.w, maxW)),
		h: Math.max(WIDGET_MIN_H, Math.min(floored.h, maxH)),
	};
}

/** Pixel rectangle for a widget placed at cell `(col,row)` spanning `w×h` cells
 *  on the fixed 8px grid. The geometry the dashboard reports to the main-process
 *  widget host so the native overlay sits on the slot. */
export function widgetRectPx(placement: {
	col: number;
	row: number;
	w: number;
	h: number;
}): { x: number; y: number; width: number; height: number } {
	return {
		x: GRID_OUTER_MARGIN + placement.col * WIDGET_UNIT,
		y: GRID_OUTER_MARGIN + placement.row * WIDGET_UNIT,
		width: Math.max(0, placement.w) * WIDGET_UNIT,
		height: Math.max(0, placement.h) * WIDGET_UNIT,
	};
}

export type IconIntent = { id: string; col: number; row: number };
export type IconPlacement = { id: string; col: number; row: number };

/** Resolve overlapping cell-intents into placements. Sort order is
 *  Free placement: an icon stays exactly where it's stored (clamped to ≥ 0).
 *  There is NO collision resolution — overlapping is allowed (the user owns the
 *  layout). Multi-device conflicts simply render both icons at their spots. */
export function layoutIcons(intents: readonly IconIntent[]): IconPlacement[] {
	return intents.map(({ id, col, row }) => ({
		id,
		col: Math.max(0, Math.floor(col)),
		row: Math.max(0, Math.floor(row)),
	}));
}

// --- One-time migration off the pre-8px coarse 14-column grid ---

/** A stored layout is pre-8px (coarse 14-col cells) when EVERY icon sits within
 *  `LEGACY_GRID_MAX` of the origin — those tiny indices would cluster every icon
 *  in the top-left on the 8px grid. A populated 8px layout spreads past it. */
export function isLegacyIconLayout(cells: readonly GridCell[]): boolean {
	return (
		cells.length > 0 && cells.every((c) => c.col <= LEGACY_GRID_MAX && c.row <= LEGACY_GRID_MAX)
	);
}

/** Re-pack icon ids into a tidy `columns`-wide 8px grid (footprint-stepped). The
 *  chosen one-time migration for a pre-8px layout — order is preserved so the
 *  arrangement stays recognisable. */
export function repackIcons(ids: readonly string[], columns: number): IconPlacement[] {
	const cols = Math.max(1, Math.floor(columns));
	return ids.map((id, i) => ({
		id,
		col: (i % cols) * ICON_FOOTPRINT_W,
		row: Math.floor(i / cols) * ICON_FOOTPRINT_H,
	}));
}
