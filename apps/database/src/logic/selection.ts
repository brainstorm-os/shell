/**
 * Selection state for view rows.
 *
 * Anchor + cursor model — `anchor` is the last single-click target;
 * `range` shift-click expands from anchor to cursor over the *current
 * row order* (`orderedIds`). Plain click replaces the set with the
 * single target. Cmd/Ctrl click toggles a single id without disturbing
 * the rest.
 *
 * The selection is rendered identifier-by-identifier — `selectedIds`
 * is a `Set<string>` consumed by every view renderer.
 *
 * The range + toggle math lives in `@brainstorm-os/sdk/selection` (shared
 * with the Files content pane); this module keeps the Database's
 * mutable-`Set` state shape and click API around it.
 */

import { computeRange, toggleId } from "@brainstorm-os/sdk/selection";

export type SelectionState = {
	selectedIds: Set<string>;
	anchorId: string | null;
};

export type SelectionModifiers = {
	shiftKey: boolean;
	metaKey: boolean;
};

export function createSelection(): SelectionState {
	return { selectedIds: new Set(), anchorId: null };
}

export function applyClick(
	state: SelectionState,
	id: string,
	modifiers: SelectionModifiers,
	orderedIds: ReadonlyArray<string>,
): SelectionState {
	if (modifiers.shiftKey && state.anchorId !== null) {
		const range = computeRange(state.anchorId, id, orderedIds);
		const selectedIds = new Set(range);
		return { selectedIds, anchorId: state.anchorId };
	}
	if (modifiers.metaKey) {
		return { selectedIds: toggleId(state.selectedIds, id), anchorId: id };
	}
	return { selectedIds: new Set([id]), anchorId: id };
}

export function clearSelection(): SelectionState {
	return { selectedIds: new Set(), anchorId: null };
}

export function isSelected(state: SelectionState, id: string): boolean {
	return state.selectedIds.has(id);
}
