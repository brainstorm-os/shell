/**
 * Multi-select state machine for the content pane.
 *
 * Per §Selection. Pure logic — the
 * renderer dispatches click events with `{ id, mods }` and the reducer
 * returns the next selection state. The state-machine semantics:
 *
 *   - **plain** click: replace selection with `[id]`; anchor := id.
 *   - **Shift+click**: range from anchor to id (inclusive); anchor unchanged.
 *   - **Mod+click** (Cmd on mac / Ctrl elsewhere): toggle id; anchor := id.
 *   - **Mod+A**: select all (caller passes the visible id list).
 *   - **clear**: empty selection; anchor := null.
 *
 * The reducer requires a *positional* member list at apply time because
 * range-select needs ordering. Position is supplied by the renderer per
 * the current sort, so range selection follows what the user sees.
 *
 * This module is a long-term keystone: the algorithm survives the
 * entities-service swap and the React rewrite — only the React wrapper
 * (`useReducer`) changes.
 *
 * The range/toggle math + the `SelectionModifier` enum + `modifierFromEvent`
 * live in `@brainstorm-os/sdk/selection` (shared with the Database views);
 * this module keeps the Files content pane's frozen reducer state shape.
 */

import {
	SelectionModifier,
	computeRange,
	modifierFromEvent,
	toggleId,
} from "@brainstorm-os/sdk/selection";

export { SelectionModifier, modifierFromEvent } from "@brainstorm-os/sdk/selection";

export type SelectionState = {
	readonly anchorId: string | null;
	readonly selected: ReadonlySet<string>;
};

export const EMPTY_SELECTION: SelectionState = Object.freeze({
	anchorId: null,
	selected: Object.freeze(new Set<string>()) as ReadonlySet<string>,
});

export type SelectionAction =
	| { kind: "click"; id: string; modifier: SelectionModifier; order: ReadonlyArray<string> }
	| { kind: "selectAll"; order: ReadonlyArray<string> }
	| { kind: "clear" }
	| { kind: "set"; ids: ReadonlyArray<string>; anchorId: string | null };

export function selectionReducer(state: SelectionState, action: SelectionAction): SelectionState {
	switch (action.kind) {
		case "clear":
			return EMPTY_SELECTION;
		case "selectAll":
			return {
				anchorId: action.order.length > 0 ? (action.order[0] ?? null) : null,
				selected: new Set(action.order),
			};
		case "set":
			return { anchorId: action.anchorId, selected: new Set(action.ids) };
		case "click":
			return applyClick(state, action.id, action.modifier, action.order);
	}
}

function applyClick(
	state: SelectionState,
	id: string,
	modifier: SelectionModifier,
	order: ReadonlyArray<string>,
): SelectionState {
	if (!order.includes(id)) return state;
	switch (modifier) {
		case SelectionModifier.None:
			return { anchorId: id, selected: new Set([id]) };
		case SelectionModifier.Toggle:
			return { anchorId: id, selected: toggleId(state.selected, id) };
		case SelectionModifier.Range: {
			// `order.includes(id)` is guaranteed by the guard above, so the
			// only degenerate case is a stale anchor no longer in `order`,
			// where the anchor resets to the clicked id (computeRange → [id]).
			const anchor = state.anchorId ?? id;
			const ids = computeRange(anchor, id, order);
			return { anchorId: order.includes(anchor) ? anchor : id, selected: new Set(ids) };
		}
	}
}

export function isSelected(state: SelectionState, id: string): boolean {
	return state.selected.has(id);
}

export function selectionSize(state: SelectionState): number {
	return state.selected.size;
}
