/**
 * `@brainstorm-os/sdk/a11y` composite-keyboard controller — the pure index-walk
 * half of `useCompositeKeyboard`. NO DOM, NO React, NO event listeners. KBN-1b
 * will bind this to live nodes (roving `tabindex`, focus management) but the
 * arithmetic — wrap / no-wrap, disabled-skip, grid row/column moves, page-by,
 * Home/End, type-ahead jumps — is decided here in a fully-testable reducer,
 * mirroring `nav-history` / `find-controller`.
 *
 * Disabled invariant per `61-keyboard-accessibility.md §Focus management
 * invariants`: Arrow walks *past* a disabled item — it's reachable in the
 * sense that screen-readers must still announce it, but the active cursor
 * never *lands* on it. The controller searches forward / backward past
 * disabled until it finds a focusable index or runs out (no-op).
 */

import { Orientation } from "./orientation";
import { type SpatialCell, SpatialDirection, spatialGridStep } from "./spatial-grid";

/** Discriminator for one keypress's intent — enum, not bare literals. */
export enum CompositeKey {
	Next = "next",
	Previous = "previous",
	NextRow = "next-row",
	PreviousRow = "previous-row",
	Home = "home",
	End = "end",
	PageDown = "page-down",
	PageUp = "page-up",
	/**
	 * Activate (Enter / Space) is a no-op on `CompositeState` by design — the
	 * intent doesn't change `activeIndex`, the orientation, or any other field
	 * the reducer owns. Returning unchanged state means the reducer can't fire
	 * an `onActivate` side-channel; `useCompositeKeyboard` instead inspects the
	 * inbound key and calls `onActivate(activeIndex)` before dispatching to the
	 * reducer. The asymmetry is documented; don't try to thread it back here.
	 */
	Activate = "activate",
	Typeahead = "typeahead",
}

export type CompositeState = {
	readonly activeIndex: number;
	readonly orientation: Orientation;
	readonly count: number;
	readonly columns: number;
	readonly wrap: boolean;
	readonly pageSize: number;
};

export type CompositeInitOptions = {
	orientation: Orientation;
	count: number;
	activeIndex?: number;
	columns?: number;
	wrap?: boolean;
	pageSize?: number;
};

export type CompositeKeyContext = {
	disabled?: ReadonlySet<number>;
	typeaheadIndex?: number;
	pageSize?: number;
	/** `{col, row}` of each item, index-aligned with the composite. Required for
	 *  `Orientation.Spatial` (the directional keys resolve via `spatialGridStep`);
	 *  ignored otherwise. */
	cells?: ReadonlyArray<SpatialCell>;
};

const DEFAULT_PAGE_SIZE = 10;

function clampStart(count: number, activeIndex: number): number {
	if (count <= 0) return -1;
	if (activeIndex < 0) return 0;
	if (activeIndex >= count) return count - 1;
	return activeIndex;
}

function resolveColumns(
	orientation: Orientation,
	count: number,
	columns: number | undefined,
): number {
	if (orientation === Orientation.Grid) {
		// A grid with `columns <= 0` would divide-by-zero in row math; clamp
		// to a safe minimum so the controller stays total.
		const c = columns ?? 1;
		return c > 0 ? c : 1;
	}
	return Math.max(1, count);
}

export function compositeInit(opts: CompositeInitOptions): CompositeState {
	// Number.isFinite guards NaN / +-Infinity — both slip past Math.max(0, x) since
	// Math.max(0, NaN) === NaN, which would wedge every count===0 guard downstream.
	const count = Number.isFinite(opts.count) ? Math.max(0, Math.floor(opts.count)) : 0;
	const orientation = opts.orientation;
	const columns = resolveColumns(orientation, count, opts.columns);
	const wrap = opts.wrap !== false;
	const pageSize = Math.max(1, opts.pageSize ?? DEFAULT_PAGE_SIZE);
	const activeIndex = count === 0 ? -1 : clampStart(count, opts.activeIndex ?? 0);
	return Object.freeze({ activeIndex, orientation, count, columns, wrap, pageSize });
}

function isDisabled(disabled: ReadonlySet<number> | undefined, i: number): boolean {
	return disabled?.has(i) === true;
}

function firstEnabled(count: number, disabled: ReadonlySet<number> | undefined): number {
	for (let i = 0; i < count; i++) {
		if (!isDisabled(disabled, i)) return i;
	}
	return -1;
}

function lastEnabled(count: number, disabled: ReadonlySet<number> | undefined): number {
	for (let i = count - 1; i >= 0; i--) {
		if (!isDisabled(disabled, i)) return i;
	}
	return -1;
}

/** Search forward from `start` (inclusive) for the first non-disabled index.
 *  When `wrap`, continues from 0 once past `count - 1`. Returns -1 when every
 *  index is disabled. */
function seekForward(
	start: number,
	count: number,
	disabled: ReadonlySet<number> | undefined,
	wrap: boolean,
): number {
	if (count <= 0) return -1;
	const limit = wrap ? count : count - start;
	for (let step = 0; step < limit; step++) {
		const i = wrap ? (start + step) % count : start + step;
		if (i >= count) return -1;
		if (!isDisabled(disabled, i)) return i;
	}
	return -1;
}

function seekBackward(
	start: number,
	count: number,
	disabled: ReadonlySet<number> | undefined,
	wrap: boolean,
): number {
	if (count <= 0) return -1;
	const limit = wrap ? count : start + 1;
	for (let step = 0; step < limit; step++) {
		const i = wrap ? (start - step + count) % count : start - step;
		if (i < 0) return -1;
		if (!isDisabled(disabled, i)) return i;
	}
	return -1;
}

function withActiveIndex(state: CompositeState, next: number): CompositeState {
	if (next === state.activeIndex) return state;
	return Object.freeze({ ...state, activeIndex: next });
}

/** Spatial move (macOS-Desktop nearest-in-direction) for `Orientation.Spatial`.
 *  A first move from "no selection" lands on index 0; otherwise it delegates to
 *  the pure `spatialGridStep` over `ctx.cells`. */
function moveSpatial(
	state: CompositeState,
	direction: SpatialDirection,
	ctx: CompositeKeyContext | undefined,
): CompositeState {
	if (state.count === 0) return state;
	if (state.activeIndex < 0) return withActiveIndex(state, 0);
	const cells = ctx?.cells;
	if (cells === undefined) return state;
	const next = spatialGridStep(cells, state.activeIndex, direction);
	if (next === state.activeIndex) return state;
	return withActiveIndex(state, next);
}

function moveNext(state: CompositeState, ctx: CompositeKeyContext | undefined): CompositeState {
	if (state.orientation === Orientation.Spatial)
		return moveSpatial(state, SpatialDirection.Right, ctx);
	if (state.count === 0) return state;
	const disabled = ctx?.disabled;
	const start = state.activeIndex < 0 ? 0 : state.activeIndex + 1;
	if (!state.wrap && start >= state.count) return state;
	const next = seekForward(start, state.count, disabled, state.wrap);
	if (next < 0) return state;
	return withActiveIndex(state, next);
}

function movePrevious(state: CompositeState, ctx: CompositeKeyContext | undefined): CompositeState {
	if (state.orientation === Orientation.Spatial)
		return moveSpatial(state, SpatialDirection.Left, ctx);
	if (state.count === 0) return state;
	const disabled = ctx?.disabled;
	const start = state.activeIndex < 0 ? state.count - 1 : state.activeIndex - 1;
	if (!state.wrap && start < 0) return state;
	const next = seekBackward(start, state.count, disabled, state.wrap);
	if (next < 0) return state;
	return withActiveIndex(state, next);
}

/** Page-by jump — paging is bounded (per spec): it never wraps and never
 *  reverses direction. PageDown searches the half-open span (active, active+size]
 *  for the cell nearest the target end; if every cell in the span is disabled,
 *  it stays put. The earlier bidirectional-fallback shape could regress past
 *  the active index when a disabled gap covered the entire forward span. */
function pageForward(state: CompositeState, ctx: CompositeKeyContext | undefined): CompositeState {
	if (state.count === 0) return state;
	const size = Math.max(1, ctx?.pageSize ?? state.pageSize);
	const lowerBound = state.activeIndex + 1;
	const upperBound = Math.min(state.count - 1, state.activeIndex + size);
	if (lowerBound > upperBound) return state;
	const disabled = ctx?.disabled;
	for (let i = upperBound; i >= lowerBound; i--) {
		if (!isDisabled(disabled, i)) return withActiveIndex(state, i);
	}
	return state;
}

function pageBackward(state: CompositeState, ctx: CompositeKeyContext | undefined): CompositeState {
	if (state.count === 0) return state;
	const size = Math.max(1, ctx?.pageSize ?? state.pageSize);
	const upperBound = state.activeIndex - 1;
	const lowerBound = Math.max(0, state.activeIndex - size);
	if (lowerBound > upperBound) return state;
	const disabled = ctx?.disabled;
	for (let i = lowerBound; i <= upperBound; i++) {
		if (!isDisabled(disabled, i)) return withActiveIndex(state, i);
	}
	return state;
}

function home(state: CompositeState, ctx: CompositeKeyContext | undefined): CompositeState {
	const next = firstEnabled(state.count, ctx?.disabled);
	if (next < 0) return state;
	return withActiveIndex(state, next);
}

function end(state: CompositeState, ctx: CompositeKeyContext | undefined): CompositeState {
	const next = lastEnabled(state.count, ctx?.disabled);
	if (next < 0) return state;
	return withActiveIndex(state, next);
}

function moveRow(
	state: CompositeState,
	direction: 1 | -1,
	ctx: CompositeKeyContext | undefined,
): CompositeState {
	if (state.orientation === Orientation.Spatial)
		return moveSpatial(state, direction === 1 ? SpatialDirection.Down : SpatialDirection.Up, ctx);
	if (state.count === 0 || state.orientation !== Orientation.Grid) return state;
	const disabled = ctx?.disabled;
	const current = state.activeIndex < 0 ? 0 : state.activeIndex;
	const candidate = current + direction * state.columns;
	if (candidate < 0 || candidate >= state.count) return state;
	// Land on the candidate cell if enabled; otherwise prefer the same row
	// (search forward from the candidate within the row) before falling back
	// to global walks. This keeps grid moves visually-row-bound — the user's
	// mental model is "the cell directly below" first, not "anywhere".
	if (!isDisabled(disabled, candidate)) return withActiveIndex(state, candidate);
	const rowStart = candidate - (candidate % state.columns);
	const rowEnd = Math.min(state.count - 1, rowStart + state.columns - 1);
	for (let i = candidate + 1; i <= rowEnd; i++) {
		if (!isDisabled(disabled, i)) return withActiveIndex(state, i);
	}
	for (let i = candidate - 1; i >= rowStart; i--) {
		if (!isDisabled(disabled, i)) return withActiveIndex(state, i);
	}
	return state;
}

function typeahead(state: CompositeState, ctx: CompositeKeyContext | undefined): CompositeState {
	if (state.count === 0) return state;
	const target = ctx?.typeaheadIndex;
	if (typeof target !== "number" || target < 0 || target >= state.count) return state;
	if (isDisabled(ctx?.disabled, target)) return state;
	return withActiveIndex(state, target);
}

export function compositeKey(
	state: CompositeState,
	key: CompositeKey,
	ctx?: CompositeKeyContext,
): CompositeState {
	switch (key) {
		case CompositeKey.Next:
			return moveNext(state, ctx);
		case CompositeKey.Previous:
			return movePrevious(state, ctx);
		case CompositeKey.NextRow:
			return moveRow(state, 1, ctx);
		case CompositeKey.PreviousRow:
			return moveRow(state, -1, ctx);
		case CompositeKey.Home:
			return home(state, ctx);
		case CompositeKey.End:
			return end(state, ctx);
		case CompositeKey.PageDown:
			return pageForward(state, ctx);
		case CompositeKey.PageUp:
			return pageBackward(state, ctx);
		case CompositeKey.Activate:
			return state;
		case CompositeKey.Typeahead:
			return typeahead(state, ctx);
	}
}

/**
 * The ARIA container + item roles a composite stamps for an orientation,
 * after applying caller overrides. Pure + exported so the role contract is
 * unit-testable without a React render, and so `useCompositeKeyboard` callers
 * spreading `containerProps` never hand-write `role="listbox"` — which the
 * KBN-G-roles gate rejects (the role must flow through the hook, per
 * 61-keyboard-accessibility.md §Validation). Defaults: a flat list is a
 * `listbox` of `option`s; a 2-D grid is a `grid` of `gridcell`s; a `toolbar`
 * has NO item role (its items are native controls). Override for a
 * `tablist`/`tab`, `radiogroup`/`radio`, etc.
 */
export function compositeRoles(
	orientation: Orientation,
	role?: string,
	itemRole?: string,
): { containerRole: string; itemRole: string | undefined } {
	const isGrid = orientation === Orientation.Grid;
	const containerRole = role ?? (isGrid ? "grid" : "listbox");
	// A `toolbar` / `group` holds native interactive controls (buttons) that keep
	// their implicit role — stamping `role="button"` on a `<button>` is both
	// redundant (flagged by `noRedundantRoles`) and wrong. So their items take no
	// item role unless the caller explicitly sets one.
	const nativeItemContainer = containerRole === "toolbar" || containerRole === "group";
	const defaultItemRole = nativeItemContainer ? undefined : isGrid ? "gridcell" : "option";
	return { containerRole, itemRole: itemRole ?? defaultItemRole };
}
