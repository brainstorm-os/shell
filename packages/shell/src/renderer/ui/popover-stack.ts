/**
 * Popover stacking registry — the shared bookkeeping that makes a dialog
 * opened from INSIDE another dialog readable and safe.
 *
 * Why this exists: every `<Popover>` paints at the same `--z-popover` (50) and
 * every panel is a translucent `.glass` surface with a `backdrop-filter`. Open
 * a confirm from inside a picker popover (Marketplace → "Install from vault"
 * → Install → "Install <app>?") and the child samples the parent straight
 * through its own panel: the two bodies' text composite into one unreadable
 * layer and the parent's footer buttons show through next to the child's. On
 * the consent surface — the one place the product must look trustworthy —
 * that is a correctness bug, not a polish nit.
 *
 * Two halves, deliberately split:
 *
 *   - **Depth** is a React subscription (`subscribePopoverStack` +
 *     `getPopoverStackIds`). A popover reads its own index; before its mount
 *     effect has registered it, `stackDepthOf` falls back to the current
 *     length — which is the depth it is about to land on. That makes the
 *     stacked styling correct on the very first paint (no un-stacked flash)
 *     AND self-correcting: if the dialog underneath closes first, the upper
 *     one drops back to depth 0 and returns to glass.
 *   - **Inertness** is applied IMPERATIVELY here rather than through React
 *     state on the popover below. That is not a shortcut: on unmount React
 *     runs layout-effect cleanups (this unregister) during the commit but
 *     flushes the *passive* cleanup that restores focus to the opener before
 *     it re-renders anyone. A React-state `inert` on the parent would still be
 *     set when `useFocusTrap` calls `opener.focus()`, and the focus restore
 *     would silently no-op. Unregistering synchronously un-inerts the new top
 *     first, so the restore lands.
 *
 * `inert` alone is enough for modern Chromium (it removes focusability, hit
 * testing and AT exposure); `aria-hidden` rides along for AT that predates
 * inert semantics. They are applied and removed together so the two can never
 * disagree.
 */

type PopoverStackEntry = {
	readonly id: string;
	readonly element: HTMLElement;
};

let entries: readonly PopoverStackEntry[] = [];
/** Cached id snapshot — `useSyncExternalStore` requires a referentially
 *  stable value between changes or it re-renders forever. */
let ids: readonly string[] = [];
const listeners = new Set<() => void>();

/**
 * Cap on how far a stacked popover raises its own z-index. `--z-popover` is
 * 50 and `--z-toast` is 60, so a pathological stack must never climb over the
 * toast layer.
 */
export const MAX_STACKED_POPOVER_LIFT = 9;

function applyInertness(): void {
	const topIndex = entries.length - 1;
	entries.forEach((entry, index) => {
		if (index === topIndex) {
			entry.element.removeAttribute("inert");
			entry.element.removeAttribute("aria-hidden");
			return;
		}
		entry.element.setAttribute("inert", "");
		entry.element.setAttribute("aria-hidden", "true");
	});
}

function commit(next: readonly PopoverStackEntry[]): void {
	entries = next;
	ids = next.map((entry) => entry.id);
	applyInertness();
	for (const listener of [...listeners]) listener();
}

/** Bottom-to-top ids of the currently mounted popovers. */
export function getPopoverStackIds(): readonly string[] {
	return ids;
}

export function subscribePopoverStack(onChange: () => void): () => void {
	listeners.add(onChange);
	return () => {
		listeners.delete(onChange);
	};
}

/**
 * A popover's depth in `stack`. An id that isn't registered yet is mid-mount:
 * it is about to be pushed on top, so its depth is the current length — which
 * is what makes the stacked styling right on the first paint.
 */
export function stackDepthOf(stack: readonly string[], id: string): number {
	const index = stack.indexOf(id);
	return index === -1 ? stack.length : index;
}

/**
 * Register a mounted popover root as the new top of the stack. Returns the
 * unregister — call it from the same layout effect's cleanup.
 */
export function registerPopover(id: string, element: HTMLElement): () => void {
	commit([...entries.filter((entry) => entry.id !== id), { id, element }]);
	return () => {
		if (!entries.some((entry) => entry.id === id)) return;
		commit(entries.filter((entry) => entry.id !== id));
	};
}

/** Test-only reset so a leaked entry can't bleed between specs. */
export function _resetPopoverStackForTests(): void {
	entries = [];
	ids = [];
}
