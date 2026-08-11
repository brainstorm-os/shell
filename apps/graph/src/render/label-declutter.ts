/**
 * Screen-space label de-clutter (F-230). The label overlay can want more
 * labels than the screen can legibly hold: when hub nodes cluster near the
 * centre their captions overprint into an unreadable smear
 * ("Co…ndar" over "Content Calendar" over "Candidates"). The wanted-set
 * logic in `syncLabelOverlay` decides *which* nodes deserve a label by
 * zoom/density/degree; this decides which of those actually paint once their
 * screen rectangles are known, so overlapping captions don't stack.
 *
 * Pure + DOM-free so it unit-tests deterministically. The renderer measures
 * each candidate's screen box (centre + estimated width) and hands them here
 * in priority order; we keep a label only when its axis-aligned box clears
 * every already-kept box. Greedy-by-priority means the most important labels
 * (hovered first, then highest-degree hubs) win the space and the rest drop.
 *
 * This tests label-vs-LABEL only, and deliberately still does after
 * POLISH-DSN-13 ("node titles painted into the tangle"). A label sitting over
 * a *disc* is a legibility problem, and legibility is now solved at the paint
 * layer by the chip (`.graph-canvas__label`: elevated surface + border), which
 * costs nothing per frame. Suppressing those labels instead would delete
 * captions exactly where the graph is dense — the region the user most needs
 * named — and would cost an O(labels × visible nodes) sweep every frame at the
 * 600-node cap. Occluding a disc is the smaller harm than dropping its name;
 * a chip that can't be read is no harm at all, it's just noise.
 */

/** One label's screen-space footprint + how much it deserves to survive a
 *  collision. Higher `priority` wins; ties keep input order. */
export type LabelBox = {
	id: string;
	/** Horizontal centre of the label in screen pixels. */
	centerX: number;
	/** Top edge of the label in screen pixels (labels sit below their node). */
	top: number;
	/** Estimated rendered width in screen pixels. */
	width: number;
	/** Rendered height in screen pixels (font line box). */
	height: number;
	/** Survival rank — hovered node highest, then degree-derived. */
	priority: number;
};

/** Padding (px) added around each box before the overlap test so kept labels
 *  keep a legible gutter rather than touching edge-to-edge. */
const COLLISION_PADDING = 2;

function overlaps(a: LabelBox, b: LabelBox): boolean {
	const aLeft = a.centerX - a.width / 2 - COLLISION_PADDING;
	const aRight = a.centerX + a.width / 2 + COLLISION_PADDING;
	const aTop = a.top - COLLISION_PADDING;
	const aBottom = a.top + a.height + COLLISION_PADDING;
	const bLeft = b.centerX - b.width / 2 - COLLISION_PADDING;
	const bRight = b.centerX + b.width / 2 + COLLISION_PADDING;
	const bTop = b.top - COLLISION_PADDING;
	const bBottom = b.top + b.height + COLLISION_PADDING;
	return aLeft < bRight && aRight > bLeft && aTop < bBottom && aBottom > bTop;
}

/** Resolve overlaps greedily: sort by descending priority (stable on ties via
 *  the original index), then accept a label only if it clears every already-
 *  accepted box. Returns the ids to paint. O(n²) in the kept-set size — n is
 *  bounded by the wanted-set (hub cap or density cap), so this stays cheap
 *  per frame. */
export function declutterLabels(candidates: readonly LabelBox[]): Set<string> {
	const ordered = candidates
		.map((box, index) => ({ box, index }))
		.sort((a, b) => b.box.priority - a.box.priority || a.index - b.index);

	const kept: LabelBox[] = [];
	const keptIds = new Set<string>();
	for (const { box } of ordered) {
		if (kept.some((other) => overlaps(box, other))) continue;
		kept.push(box);
		keptIds.add(box.id);
	}
	return keptIds;
}

/** Per-character width estimate (px) for the 10px UI font the overlay paints
 *  with. A cheap proxy for `measureText` — exact pixel widths aren't needed;
 *  the box only has to be close enough to catch the visually-overlapping
 *  captions the user reads as a smear. */
const AVG_GLYPH_WIDTH_PX = 5.6;

/**
 * The label is a CHIP, not a bare glyph run (POLISH-DSN-13): `.graph-canvas__
 * label` carries `padding: var(--space-0_5) var(--space-1)` (2px / 4px) and a
 * 1px border over the elevated surface, so it can be read against the discs
 * and edges it floats over. The three constants below MIRROR that rule — the
 * de-clutter pass measures what actually paints, or two chips overlap by the
 * padding on each side and nothing here ever sees it.
 */
const CHIP_PADDING_X_PX = 4;
const CHIP_PADDING_Y_PX = 2;
const CHIP_BORDER_PX = 1;

/** Screen px the chip adds to a label's glyph run horizontally (both sides). */
export const LABEL_CHIP_EXTRA_X_PX = 2 * (CHIP_PADDING_X_PX + CHIP_BORDER_PX);

/** The `max-width` the chip renders at, mirroring the CSS. Border-box sizing
 *  means this caps the whole chip, so a 48-glyph name (the `nodeLabel`
 *  character ceiling, ~278px of raw glyphs) paints exactly this wide with the
 *  overflow ellipsised. Estimating past it drops neighbours that never
 *  actually collided. */
export const LABEL_MAX_WIDTH_PX = 180;

/** Estimate a label chip's rendered width (px): the glyph run from its
 *  character count, plus the chip's padding + border, clamped at the CSS
 *  `max-width` where the text ellipsises. */
export function estimateLabelWidth(text: string): number {
	const glyphs = text.length * AVG_GLYPH_WIDTH_PX;
	return Math.min(glyphs + LABEL_CHIP_EXTRA_X_PX, LABEL_MAX_WIDTH_PX);
}

/** A label chip's rendered height (px) for a given font line box — the line
 *  plus the chip's vertical padding + border. */
export function labelBoxHeight(lineHeightPx: number): number {
	return lineHeightPx + 2 * (CHIP_PADDING_Y_PX + CHIP_BORDER_PX);
}
