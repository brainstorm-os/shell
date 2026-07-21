/**
 * Overview-list keyboard binding (KBN-A-journal) — the all-entries reading
 * list in the nav sidebar is a single vertical listbox even though its rows
 * are split into per-month `<ul>`s. This wires the shared
 * `attachCompositeKeyboard` over the rows (queried by `.journal__overview-btn`,
 * each carrying a continuous `data-composite-index`), stamping `role="listbox"`
 * / `option` + roving tabindex and routing Enter / click to the same `onOpen`
 * action. Extracted from `app.ts` so it's unit-testable without booting the
 * whole journal app (which mounts the Lexical editor on import).
 */

import { Orientation, attachCompositeKeyboard } from "@brainstorm-os/sdk/a11y";
import type { CompositeKeyboardHandle } from "@brainstorm-os/sdk/a11y";

export type OverviewKeyboardOptions = {
	count: () => number;
	initialActiveIndex: number;
	onOpen: (index: number) => void;
};

export function attachOverviewKeyboard(
	listHost: HTMLElement,
	opts: OverviewKeyboardOptions,
): CompositeKeyboardHandle {
	let activeIndex = opts.initialActiveIndex >= 0 ? opts.initialActiveIndex : 0;
	return attachCompositeKeyboard(listHost, {
		orientation: Orientation.Vertical,
		itemSelector: ".journal__overview-btn",
		count: opts.count,
		activeIndex: () => activeIndex,
		onActiveIndexChange: (i) => {
			activeIndex = i;
		},
		onActivate: (i) => opts.onOpen(i),
	});
}
