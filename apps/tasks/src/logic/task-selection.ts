/**
 * Multi-select state for the task list — the "select several rows, then copy /
 * delete them" affordance (the editor-block-selection analogue the user asked
 * for). Kept SEPARATE from `state.selectedTaskId` (which is the single *open*
 * task driving the inspector): a plain click still opens one task, while
 * Mod-click / Shift-click build this copy-selection without opening anything.
 *
 * The range/toggle math + `SelectionModifier` + `modifierFromEvent` live in
 * `@brainstorm-os/sdk/selection`; per that module's contract each app keeps its
 * own state container. This mirrors the Files content-pane reducer
 * (`apps/files/src/logic/selection.ts`) — a frozen reducer so a stale snapshot
 * can never be mutated under a pending render.
 */

import {
	SelectionModifier,
	computeRange,
	modifierFromEvent,
	toggleId,
} from "@brainstorm-os/sdk/selection";

export { SelectionModifier, modifierFromEvent } from "@brainstorm-os/sdk/selection";

export type TaskSelectionState = {
	readonly anchorId: string | null;
	readonly selected: ReadonlySet<string>;
};

export const EMPTY_TASK_SELECTION: TaskSelectionState = Object.freeze({
	anchorId: null,
	selected: Object.freeze(new Set<string>()) as ReadonlySet<string>,
});

/** Apply a modifier-click to the selection over the current visible `order`.
 *  Plain (None) clicks are NOT routed here — the list opens the task on those;
 *  only Mod / Shift clicks reach this reducer. */
export function applyTaskClick(
	state: TaskSelectionState,
	id: string,
	modifier: SelectionModifier,
	order: ReadonlyArray<string>,
): TaskSelectionState {
	if (!order.includes(id)) return state;
	switch (modifier) {
		case SelectionModifier.None:
			return { anchorId: id, selected: new Set([id]) };
		case SelectionModifier.Toggle:
			return { anchorId: id, selected: toggleId(state.selected, id) };
		case SelectionModifier.Range: {
			const anchor = state.anchorId ?? id;
			const ids = computeRange(anchor, id, order);
			return { anchorId: order.includes(anchor) ? anchor : id, selected: new Set(ids) };
		}
	}
}

/** Select every visible row (Mod+A). */
export function selectAllTasks(order: ReadonlyArray<string>): TaskSelectionState {
	if (order.length === 0) return EMPTY_TASK_SELECTION;
	return { anchorId: order[0] ?? null, selected: new Set(order) };
}

/** Drop any id no longer visible (surface switch, filter, deletion) so the
 *  selection can't carry ghosts. Returns the same reference when nothing
 *  changed, so callers can skip a render. */
export function pruneTaskSelection(
	state: TaskSelectionState,
	order: ReadonlyArray<string>,
): TaskSelectionState {
	const visible = new Set(order);
	let changed = false;
	const next = new Set<string>();
	for (const id of state.selected) {
		if (visible.has(id)) next.add(id);
		else changed = true;
	}
	if (!changed) return state;
	const anchorId = state.anchorId !== null && visible.has(state.anchorId) ? state.anchorId : null;
	return { anchorId, selected: next };
}

export function isTaskSelected(state: TaskSelectionState, id: string): boolean {
	return state.selected.has(id);
}

export function taskSelectionSize(state: TaskSelectionState): number {
	return state.selected.size;
}
