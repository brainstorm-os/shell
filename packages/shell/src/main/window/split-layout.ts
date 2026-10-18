/**
 * Split view geometry (6.14) — pure math for a window body divided into two
 * side-by-side panes with a draggable divider between them.
 *
 * The divider is a real gap between the two app `WebContentsView`s: the shell
 * chrome view sits underneath both panes, so the gap is the one strip of the
 * chrome renderer that receives the pointer — that is what makes it draggable
 * without spawning another renderer.
 */

import { SplitStep } from "@brainstorm-os/protocol/chrome-tabs";

export { SplitStep };

export type SplitRect = { x: number; y: number; width: number; height: number };

/** Width of the divider gap, in DIP. Wide enough to grab, narrow enough that
 *  it reads as a hairline between the panes. */
export const SPLIT_DIVIDER_PX = 6;

/** Neither pane shrinks below this — doc 37 OQ-160's leaning: anything
 *  narrower cramps every app layout. */
export const SPLIT_MIN_PANE_PX = 280;

export const SPLIT_DEFAULT_RATIO = 0.5;

/** One keyboard nudge of the divider, as a share of the usable width. */
export const SPLIT_KEYBOARD_STEP = 0.05;

/** Horizontal room the two panes share once the divider is taken out. */
function usableWidth(totalWidth: number): number {
	return Math.max(0, totalWidth - SPLIT_DIVIDER_PX);
}

/** Clamp the LEFT pane's share of the usable width so both panes keep the
 *  minimum width. A window too narrow to honour both minimums splits evenly —
 *  the alternative is one pane collapsing to nothing. Non-finite input (a
 *  corrupt IPC payload) resolves to the default rather than NaN geometry. */
export function clampSplitRatio(ratio: number, totalWidth: number): number {
	if (!Number.isFinite(ratio)) return SPLIT_DEFAULT_RATIO;
	const usable = usableWidth(totalWidth);
	if (usable < SPLIT_MIN_PANE_PX * 2) return SPLIT_DEFAULT_RATIO;
	const min = SPLIT_MIN_PANE_PX / usable;
	return Math.min(1 - min, Math.max(min, ratio));
}

export function stepSplitRatio(ratio: number, step: SplitStep, totalWidth: number): number {
	const delta = step === SplitStep.Left ? -SPLIT_KEYBOARD_STEP : SPLIT_KEYBOARD_STEP;
	return clampSplitRatio(ratio + delta, totalWidth);
}

/** The left-pane ratio that puts the divider's centre under `pointerX`
 *  (window-content coordinates). */
export function ratioFromDividerX(pointerX: number, body: SplitRect): number {
	const usable = usableWidth(body.width);
	if (usable <= 0) return SPLIT_DEFAULT_RATIO;
	return clampSplitRatio((pointerX - body.x - SPLIT_DIVIDER_PX / 2) / usable, body.width);
}

export type SplitRects = { left: SplitRect; divider: SplitRect; right: SplitRect };

export function splitRects(body: SplitRect, leftRatio: number): SplitRects {
	const usable = usableWidth(body.width);
	const leftWidth = Math.round(usable * clampSplitRatio(leftRatio, body.width));
	const rightWidth = usable - leftWidth;
	return {
		left: { x: body.x, y: body.y, width: leftWidth, height: body.height },
		divider: {
			x: body.x + leftWidth,
			y: body.y,
			width: Math.min(SPLIT_DIVIDER_PX, body.width),
			height: body.height,
		},
		right: {
			x: body.x + leftWidth + SPLIT_DIVIDER_PX,
			y: body.y,
			width: rightWidth,
			height: body.height,
		},
	};
}
