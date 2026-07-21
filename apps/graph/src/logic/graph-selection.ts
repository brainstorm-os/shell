/**
 * Node selection model (9.13.11) — pure reducer over the canvas node selection.
 *
 * Single click selects (replace), Mod-click toggles, Shift-click extends a
 * range over the visible node order. Built on the shared
 * `@brainstorm-os/sdk/selection` primitives so the graph's multi-select behaves
 * exactly like the Database/Files lists. The controller owns the live `Set`;
 * this decides the next selection + anchor for a click.
 */

import { SelectionModifier, computeRange, toggleId } from "@brainstorm-os/sdk/selection";

export type NodeSelection = {
	selected: Set<string>;
	/** The range anchor — the last plainly-selected / toggled-on node. */
	anchor: string | null;
};

export const EMPTY_NODE_SELECTION: NodeSelection = { selected: new Set(), anchor: null };

/**
 * Apply a click on `id` to `current`, given the gesture `modifier` and the
 * visible node `order` (for range selection). Returns the next selection +
 * anchor. Pure — never mutates `current`.
 */
export function applyNodeSelection(
	current: NodeSelection,
	id: string,
	modifier: SelectionModifier,
	order: readonly string[],
): NodeSelection {
	switch (modifier) {
		case SelectionModifier.Toggle: {
			const selected = toggleId(current.selected, id);
			// Anchor follows a toggle-ON; a toggle-OFF leaves the prior anchor.
			return { selected, anchor: selected.has(id) ? id : current.anchor };
		}
		case SelectionModifier.Range: {
			const from = current.anchor ?? id;
			return { selected: new Set(computeRange(from, id, order)), anchor: from };
		}
		default:
			return { selected: new Set([id]), anchor: id };
	}
}

/** Drop the selection (background click / Escape). */
export function clearNodeSelection(): NodeSelection {
	return { selected: new Set(), anchor: null };
}
