/**
 * Snap-to-guides geometry (9.17.14) — pure, DOM-free.
 *
 * Given the canvas-space rect of the node(s) being dragged and the rects of
 * the other nodes on the board, find the smallest nudge (`dx`/`dy`) that
 * aligns one of the moving rect's three vertical reference lines (left /
 * centre-x / right) and three horizontal lines (top / centre-y / bottom) to
 * the matching line of a nearby node, within a pixel threshold. The X and Y
 * axes resolve independently, so a node can snap to one neighbour's left edge
 * and another's vertical centre at the same time.
 *
 * The returned `guides` are the alignment lines the renderer draws while the
 * magnet is engaged — one per snapped axis, spanning the union of the moving
 * rect and the neighbour it locked onto so the user sees *what* it aligned to.
 */

export interface SnapRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export enum SnapAxis {
	/** A vertical line — constant `pos` on the x-axis. */
	Vertical = "vertical",
	/** A horizontal line — constant `pos` on the y-axis. */
	Horizontal = "horizontal",
}

export interface SnapGuide {
	axis: SnapAxis;
	/** The aligned coordinate (x for vertical, y for horizontal). */
	pos: number;
	/** The line's extent along the other axis (the union span). */
	from: number;
	to: number;
}

export interface SnapResult {
	dx: number;
	dy: number;
	guides: SnapGuide[];
}

/** The three reference offsets of a rect along one axis: near edge, centre,
 *  far edge. Pairing every moving line against every other line covers all
 *  cross-edge matches (left-to-right, centre-to-edge, …). */
function linesX(r: SnapRect): readonly number[] {
	return [r.x, r.x + r.width / 2, r.x + r.width];
}

function linesY(r: SnapRect): readonly number[] {
	return [r.y, r.y + r.height / 2, r.y + r.height];
}

export interface AxisMatch {
	delta: number;
	pos: number;
	other: SnapRect;
}

/** Best (smallest-magnitude) alignment of any `moving` line to any `other`
 *  line across all neighbours, within `threshold`. Null when nothing is close
 *  enough. Ties resolve to the first candidate, which — because `moving` lines
 *  are ordered edge→centre→edge — prefers an edge match over a centre match
 *  only when their distances differ; equal distances keep the earlier line. */
function bestMatch(
	movingLines: readonly number[],
	others: readonly SnapRect[],
	linesOf: (r: SnapRect) => readonly number[],
	threshold: number,
): AxisMatch | null {
	let best: AxisMatch | null = null;
	for (const other of others) {
		for (const target of linesOf(other)) {
			for (const line of movingLines) {
				const delta = target - line;
				if (Math.abs(delta) > threshold) continue;
				if (!best || Math.abs(delta) < Math.abs(best.delta)) {
					best = { delta, pos: target, other };
				}
			}
		}
	}
	return best;
}

/** Best alignment of ONE moving line to any neighbour line on one axis —
 *  the resize magnet (which moves a single edge, never the whole rect)
 *  reuses the drag matcher instead of forking the tie-break rules. */
export function snapLineMatch(
	line: number,
	others: readonly SnapRect[],
	axis: SnapAxis,
	threshold: number,
): AxisMatch | null {
	return bestMatch([line], others, axis === SnapAxis.Vertical ? linesX : linesY, threshold);
}

export function computeSnap(
	moving: SnapRect,
	others: readonly SnapRect[],
	threshold: number,
): SnapResult {
	if (threshold <= 0 || others.length === 0) {
		return { dx: 0, dy: 0, guides: [] };
	}

	const x = bestMatch(linesX(moving), others, linesX, threshold);
	const y = bestMatch(linesY(moving), others, linesY, threshold);

	const guides: SnapGuide[] = [];
	const dx = x?.delta ?? 0;
	const dy = y?.delta ?? 0;

	if (x) {
		const top = Math.min(moving.y, x.other.y);
		const bottom = Math.max(moving.y + moving.height, x.other.y + x.other.height);
		guides.push({ axis: SnapAxis.Vertical, pos: x.pos, from: top, to: bottom });
	}
	if (y) {
		const left = Math.min(moving.x, y.other.x);
		const right = Math.max(moving.x + moving.width, y.other.x + y.other.width);
		guides.push({ axis: SnapAxis.Horizontal, pos: y.pos, from: left, to: right });
	}

	return { dx, dy, guides };
}
