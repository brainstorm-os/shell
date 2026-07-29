/**
 * Node-resize geometry — pure, DOM-free (the same split as `snap.ts` /
 * `containment.ts`: the engine owns pointers, this module owns the math).
 *
 * A resize gesture grabs one of eight handles on the selected node. Corner
 * handles move both axes anchored on the opposite corner; edge handles move
 * one axis anchored on the opposite edge. Invariants this module guarantees
 * (property-tested in `resize.test.ts`):
 *
 *   - the box never inverts and never drops below the per-kind minimum;
 *   - the anchor (opposite corner / edge) never moves — with the one
 *     documented exception that an aspect-locked *edge* drag re-centres the
 *     cross axis (the anchored edge itself still never moves);
 *   - with `lockAspect` the width:height ratio of the start box is preserved.
 *
 * Snap-to-guides during resize reuses the drag magnet's matcher
 * (`snapLineMatch`) but only for the edges the handle moves — the anchored
 * edges must never be nudged.
 */

import { NodeKind } from "../types/node";
import { SnapAxis, type SnapGuide, type SnapRect, snapLineMatch } from "./snap";

export type ResizeBounds = { x: number; y: number; width: number; height: number };

export enum ResizeHandle {
	NorthWest = "nw",
	North = "n",
	NorthEast = "ne",
	East = "e",
	SouthEast = "se",
	South = "s",
	SouthWest = "sw",
	West = "w",
}

/** All handles in clockwise display order — frozen, safe to iterate. */
export const RESIZE_HANDLES: readonly ResizeHandle[] = Object.freeze([
	ResizeHandle.NorthWest,
	ResizeHandle.North,
	ResizeHandle.NorthEast,
	ResizeHandle.East,
	ResizeHandle.SouthEast,
	ResizeHandle.South,
	ResizeHandle.SouthWest,
	ResizeHandle.West,
]);

export const CORNER_HANDLES: readonly ResizeHandle[] = Object.freeze([
	ResizeHandle.NorthWest,
	ResizeHandle.NorthEast,
	ResizeHandle.SouthEast,
	ResizeHandle.SouthWest,
]);

export function isCornerHandle(handle: ResizeHandle): boolean {
	return CORNER_HANDLES.includes(handle);
}

export function movesLeft(handle: ResizeHandle): boolean {
	return (
		handle === ResizeHandle.NorthWest ||
		handle === ResizeHandle.West ||
		handle === ResizeHandle.SouthWest
	);
}

export function movesRight(handle: ResizeHandle): boolean {
	return (
		handle === ResizeHandle.NorthEast ||
		handle === ResizeHandle.East ||
		handle === ResizeHandle.SouthEast
	);
}

export function movesTop(handle: ResizeHandle): boolean {
	return (
		handle === ResizeHandle.NorthWest ||
		handle === ResizeHandle.North ||
		handle === ResizeHandle.NorthEast
	);
}

export function movesBottom(handle: ResizeHandle): boolean {
	return (
		handle === ResizeHandle.SouthWest ||
		handle === ResizeHandle.South ||
		handle === ResizeHandle.SouthEast
	);
}

export type MinSize = { minWidth: number; minHeight: number };

export type ResizeConstraints = MinSize & {
	/** Preserve the start box's width:height ratio (Shift, or the image
	 *  default). Meaningless on a zero-area start box — ignored there. */
	lockAspect: boolean;
};

/** Per-kind floors, derived from the spawn defaults in `node-factory.ts` so
 *  a node can always shrink well below its spawn size but never to an
 *  un-grabbable sliver. Groups are not resizable (their box is derived from
 *  members) — the entry exists only to keep the record total. */
const MIN_SIZES: Readonly<Record<NodeKind, MinSize>> = Object.freeze({
	[NodeKind.Sticky]: { minWidth: 80, minHeight: 80 },
	[NodeKind.Text]: { minWidth: 80, minHeight: 40 },
	[NodeKind.Image]: { minWidth: 40, minHeight: 40 },
	[NodeKind.Embedded]: { minWidth: 160, minHeight: 120 },
	[NodeKind.Frame]: { minWidth: 160, minHeight: 120 },
	[NodeKind.Group]: { minWidth: 40, minHeight: 40 },
	[NodeKind.Shape]: { minWidth: 24, minHeight: 24 },
	[NodeKind.Ink]: { minWidth: 24, minHeight: 24 },
});

export function minSizeFor(kind: NodeKind): MinSize {
	return MIN_SIZES[kind];
}

/** Kinds whose box the user may resize. A Group's box is the derived union
 *  of its members, so resizing it directly would be overwritten. */
export function isResizableKind(kind: NodeKind): boolean {
	return kind !== NodeKind.Group;
}

function clampAxis(
	start: number,
	size: number,
	delta: number,
	min: number,
	movesNear: boolean,
	movesFar: boolean,
): { pos: number; size: number } {
	if (movesFar) return { pos: start, size: Math.max(min, size + delta) };
	if (movesNear) {
		const next = Math.max(min, size - delta);
		return { pos: start + size - next, size: next };
	}
	return { pos: start, size };
}

function applyAspect(
	start: ResizeBounds,
	handle: ResizeHandle,
	free: ResizeBounds,
	c: ResizeConstraints,
): ResizeBounds {
	if (start.width <= 0 || start.height <= 0) return free;
	const movesX = movesLeft(handle) || movesRight(handle);
	const movesY = movesTop(handle) || movesBottom(handle);

	// Dominant-axis scale: the axis the user stretched furthest wins, and the
	// per-kind minimum re-floors it so both dimensions stay legal.
	const sx = movesX ? free.width / start.width : 0;
	const sy = movesY ? free.height / start.height : 0;
	const scale = Math.max(sx, sy, c.minWidth / start.width, c.minHeight / start.height);
	const width = start.width * scale;
	const height = start.height * scale;

	const x = movesLeft(handle) ? start.x + start.width - width : start.x;
	const y = movesTop(handle) ? start.y + start.height - height : start.y;
	if (isCornerHandle(handle)) return { x, y, width, height };

	// Edge drag under aspect lock: the anchored edge stays put; the cross
	// axis grows symmetrically about its own centre.
	if (movesX) return { x, y: start.y + (start.height - height) / 2, width, height };
	return { x: start.x + (start.width - width) / 2, y, width, height };
}

/**
 * The resized box for a drag of (`dx`, `dy`) canvas px on `handle`, from the
 * gesture-start box `start`. Pure — call per frame with the cumulative delta.
 */
export function resizeBounds(
	start: ResizeBounds,
	handle: ResizeHandle,
	dx: number,
	dy: number,
	c: ResizeConstraints,
): ResizeBounds {
	const h = clampAxis(start.x, start.width, dx, c.minWidth, movesLeft(handle), movesRight(handle));
	const v = clampAxis(start.y, start.height, dy, c.minHeight, movesTop(handle), movesBottom(handle));
	const free: ResizeBounds = { x: h.pos, y: v.pos, width: h.size, height: v.size };
	return c.lockAspect ? applyAspect(start, handle, free, c) : free;
}

export type ResizeSnapResult = { bounds: ResizeBounds; guides: SnapGuide[] };

/**
 * Magnetise the MOVING edges of an in-flight resize to neighbour alignment
 * lines (edges + centres), within `threshold`. Anchored edges are never
 * touched — a snap adjusts the box's size (and origin for near-edge handles),
 * not its anchor. A snap that would push a dimension below the minimum is
 * skipped on that axis. Not applied under aspect lock (the caller skips —
 * a one-axis nudge would break the ratio).
 */
export function computeResizeSnap(
	bounds: ResizeBounds,
	handle: ResizeHandle,
	others: readonly SnapRect[],
	threshold: number,
	min: MinSize,
): ResizeSnapResult {
	const next = { ...bounds };
	const guides: SnapGuide[] = [];
	if (threshold <= 0 || others.length === 0) return { bounds: next, guides };

	const movingX = movesLeft(handle) ? next.x : movesRight(handle) ? next.x + next.width : null;
	if (movingX !== null) {
		const m = snapLineMatch(movingX, others, SnapAxis.Vertical, threshold);
		if (m) {
			const width = movesLeft(handle) ? next.width - m.delta : next.width + m.delta;
			if (width >= min.minWidth) {
				if (movesLeft(handle)) next.x += m.delta;
				next.width = width;
				const top = Math.min(next.y, m.other.y);
				const bottom = Math.max(next.y + next.height, m.other.y + m.other.height);
				guides.push({ axis: SnapAxis.Vertical, pos: m.pos, from: top, to: bottom });
			}
		}
	}

	const movingY = movesTop(handle) ? next.y : movesBottom(handle) ? next.y + next.height : null;
	if (movingY !== null) {
		const m = snapLineMatch(movingY, others, SnapAxis.Horizontal, threshold);
		if (m) {
			const height = movesTop(handle) ? next.height - m.delta : next.height + m.delta;
			if (height >= min.minHeight) {
				if (movesTop(handle)) next.y += m.delta;
				next.height = height;
				const left = Math.min(next.x, m.other.x);
				const right = Math.max(next.x + next.width, m.other.x + m.other.width);
				guides.push({ axis: SnapAxis.Horizontal, pos: m.pos, from: left, to: right });
			}
		}
	}

	return { bounds: next, guides };
}
