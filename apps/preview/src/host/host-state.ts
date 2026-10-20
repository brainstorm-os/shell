/**
 * Pure host state model for the 9.20.1.5 preview drop. Owns the
 * siblings list, the cursor (index into it), and the derived "active
 * file". Renderer integration lives in `app.ts`; this file is pure so
 * navigation behaviour can be unit-tested without a DOM.
 *
 * Quick-Look-style navigation: ArrowLeft / ArrowRight (or Home / End)
 * walk the list; the cursor wraps around at both ends. Wrapping is the
 * macOS Quick Look default — the alternative ("clamp at ends") makes
 * the user feel stuck.
 */

import type { PreviewFile } from "../demo/dataset";

export type HostState = {
	readonly siblings: ReadonlyArray<PreviewFile>;
	readonly cursor: number;
};

export function initState(siblings: ReadonlyArray<PreviewFile>, cursor = 0): HostState {
	const clamped = clampCursor(cursor, siblings.length);
	return { siblings, cursor: clamped };
}

export function activeFile(state: HostState): PreviewFile | null {
	if (state.siblings.length === 0) return null;
	return state.siblings[state.cursor] ?? null;
}

/** Move the cursor by `delta`, wrapping at both ends. */
export function step(state: HostState, delta: number): HostState {
	if (state.siblings.length === 0) return state;
	const next = wrap(state.cursor + delta, state.siblings.length);
	return { ...state, cursor: next };
}

/** Jump to a specific cursor index — used by the filmstrip / sidebar
 *  click handler. Out-of-range indices clamp into the valid range. */
export function jumpTo(state: HostState, index: number): HostState {
	if (state.siblings.length === 0) return state;
	return { ...state, cursor: clampCursor(index, state.siblings.length) };
}

/** Find a sibling by id; returns -1 if absent. Used to focus the
 *  filmstrip after `intent.open` resolves an explicit entityId. */
export function indexOfId(state: HostState, id: string): number {
	for (let i = 0; i < state.siblings.length; i++) {
		if (state.siblings[i]?.id === id) return i;
	}
	return -1;
}

/** Drop a sibling (e.g. it was moved to the Bin) and keep the cursor on the
 *  file that slid into its place — the next one, or the new last one when
 *  the removed file was last. Unknown ids leave the state unchanged. */
export function removeById(state: HostState, id: string): HostState {
	const index = indexOfId(state, id);
	if (index < 0) return state;
	const siblings = state.siblings.filter((_, i) => i !== index);
	const cursor = state.cursor > index ? state.cursor - 1 : state.cursor;
	return { siblings, cursor: clampCursor(cursor, siblings.length) };
}

function wrap(n: number, len: number): number {
	if (len <= 0) return 0;
	return ((n % len) + len) % len;
}

function clampCursor(n: number, len: number): number {
	if (len <= 0) return 0;
	if (n < 0) return 0;
	if (n >= len) return len - 1;
	return n;
}
