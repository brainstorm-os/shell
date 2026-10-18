/**
 * Pure positioning decision for the floating block gutter (the +/grip
 * affordance). The gutter is `position: fixed`, so its coordinates are
 * the hovered block's *viewport* rect — which only the browser knows and
 * which changes on every scroll, not just on mousemove. Keeping the math
 * here (a) lets the plugin recompute on scroll/resize from the same
 * function it uses on hover (no drift between the two paths) and (b)
 * makes the "hide when the block scrolls out of the editor" rule
 * testable without a layout engine (jsdom has none).
 */

/** The subset of `DOMRect` the anchor math needs — so callers can test
 *  with plain objects, not synthetic DOM. */
export type RectBand = { top: number; bottom: number; left: number };

export type GutterAnchor = { top: number; left: number };

/**
 * Where the gutter should sit for a block whose current rect is
 * `blockRect`, given the editor scroll container's rect `mainRect` and
 * the gutter's left inset. Returns `null` when the block is scrolled
 * outside the container's visible band — the caller hides the gutter
 * rather than leaving it frozen at a stale Y (the "buttons stuck while
 * scrolling" bug).
 */
export function gutterAnchor(
	blockRect: RectBand,
	mainRect: RectBand & { bottom: number },
	offsetLeft: number,
): GutterAnchor | null {
	// Fully above or fully below the visible band → not hoverable; hide.
	if (blockRect.bottom < mainRect.top || blockRect.top > mainRect.bottom) {
		return null;
	}
	return {
		// Align with the block's first line (flex-start), clamped so the
		// controls never ride above the scroll container's top edge while
		// the block is only partially scrolled in.
		top: Math.max(blockRect.top, mainRect.top),
		left: blockRect.left - offsetLeft,
	};
}

const EDITOR_ROOT_SELECTOR = '[data-lexical-editor="true"]';

/** Which editor's gutter owns a pointer at `clientY` when editors nest (an
 *  "Edit here" transclusion inside a note, B11.22): the innermost EDITABLE
 *  editor whose vertical band holds the pointer. The host yields inside a
 *  nested editable editor's band; a nested editor only answers inside its
 *  own band. Read-only nested editors never claim the pointer — the host's
 *  gutter keeps acting on the transclusion block as a whole. */
export function gutterOwnsPointer(root: HTMLElement, clientY: number): boolean {
	const within = (el: Element): boolean => {
		const r = el.getBoundingClientRect();
		return clientY >= r.top && clientY <= r.bottom;
	};
	const host = root.parentElement?.closest(EDITOR_ROOT_SELECTOR);
	if (host && !within(root)) return false;
	for (const nested of root.querySelectorAll<HTMLElement>(EDITOR_ROOT_SELECTOR)) {
		if (nested.getAttribute("contenteditable") === "true" && within(nested)) return false;
	}
	return true;
}
