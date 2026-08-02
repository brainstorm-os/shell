/**
 * Shared popover contract — the size / body-padding enums (exact same
 * names + values as the shell `ui/popover.tsx` so the call-site contract
 * is identical) and the one centralised Escape-matcher seam.
 *
 * Both the React `<Popover>` and the DOM `createPopoverElement` route
 * Escape through `DEFAULT_POPOVER_ESCAPE_MATCHER` (a bare-Escape test) or
 * an injected matcher — no raw inline `e.key` is scattered across the
 * module. A host with its own chord registry passes its predicate; a host
 * that owns Escape itself passes `null` to opt out.
 */

export enum PopoverSize {
	Small = "small",
	Medium = "medium",
	Large = "large",
}

export enum PopoverBodyPadding {
	Compact = "compact",
	Comfortable = "comfortable",
}

/** Predicate over a KeyboardEvent: "is this the cancel chord?". `null`
 *  opts the popover out of self-handling Escape entirely. */
export type PopoverEscapeMatcher = (event: KeyboardEvent) => boolean;

export const DEFAULT_POPOVER_ESCAPE_MATCHER: PopoverEscapeMatcher = (event) =>
	event.key === "Escape";

/** Which edge of the trigger an anchored panel lines its own edge up with.
 *  `End` is the header-⋯ / right-of-toolbar case: the panel's right edge
 *  sticks to the trigger's right edge instead of drifting left. */
export enum PopoverAlign {
	Start = "start",
	End = "end",
}

/** Viewport-space box of the trigger a popover anchors to. */
export type PopoverAnchorRect = { top: number; left: number; right: number; bottom: number };

export type PopoverBoxSize = { width: number; height: number };

export type PopoverPosition = { top: number; left: number };

/** Gap between the trigger and the anchored panel. */
export const POPOVER_ANCHOR_GUTTER = 6;

/** Minimum distance an anchored panel keeps from every viewport edge. */
export const POPOVER_VIEWPORT_MARGIN = 8;

/** Place an anchored panel below its trigger, flipping above when the panel
 *  doesn't fit below and does fit above, then clamp into the viewport.
 *  Pure — the React `<Popover>` feeds it measured rects. */
export function computeAnchoredPopoverPosition(
	anchor: PopoverAnchorRect,
	panel: PopoverBoxSize,
	viewport: PopoverBoxSize,
	align: PopoverAlign,
): PopoverPosition {
	const below = anchor.bottom + POPOVER_ANCHOR_GUTTER;
	const above = anchor.top - POPOVER_ANCHOR_GUTTER - panel.height;
	const fitsBelow = below + panel.height + POPOVER_VIEWPORT_MARGIN <= viewport.height;
	const fitsAbove = above >= POPOVER_VIEWPORT_MARGIN;
	const wantedTop = fitsBelow || !fitsAbove ? below : above;
	const maxTop = Math.max(
		POPOVER_VIEWPORT_MARGIN,
		viewport.height - panel.height - POPOVER_VIEWPORT_MARGIN,
	);
	const top = Math.max(POPOVER_VIEWPORT_MARGIN, Math.min(wantedTop, maxTop));

	const wantedLeft = align === PopoverAlign.End ? anchor.right - panel.width : anchor.left;
	const maxLeft = Math.max(
		POPOVER_VIEWPORT_MARGIN,
		viewport.width - panel.width - POPOVER_VIEWPORT_MARGIN,
	);
	const left = Math.max(POPOVER_VIEWPORT_MARGIN, Math.min(wantedLeft, maxLeft));

	return { top, left };
}
