/**
 * `@brainstorm-os/sdk/nav-history` — the ONE in-app back/forward model every
 * first-party app uses, so navigation behaves and looks identical whether
 * you're in Notes, Database, Graph, Calendar, Files, … (per CLAUDE.md DRY:
 * 9+ call sites → one shared primitive, not N hand-rolled stacks).
 *
 * Browser model, generalised off the former `apps/files/.../nav-stack.ts`
 * from `string` to a serializable per-app `Location` type `L`:
 *   - `push(loc)` records a new location, clears the forward stack;
 *   - `back()` / `forward()` walk the stack and RETURN the location the
 *     host must apply (the controller never touches app state — the app
 *     owns `applyLocation`, which keeps the seam testable and loop-free);
 *   - consecutive duplicates collapse (configurable `equals`);
 *   - the back leg is capped (`max`, default 50) so a long session can't
 *     grow it unbounded.
 *
 * The contract that keeps it loop-free: a host navigates by calling
 * `push(captureLocation())` on a *user* navigation only. `back()`/
 * `forward()` return a location which the host applies via a path that
 * does NOT itself `push` (an `applyLocation(loc)` that sets state without
 * re-recording). This mirrors how a browser's address bar doesn't push a
 * new history entry when you press the Back button.
 */

export type NavHistoryState<L> = {
	readonly current: L;
	readonly back: readonly L[];
	readonly forward: readonly L[];
};

export type NavEquals<L> = (a: L, b: L) => boolean;

const DEFAULT_MAX = 50;

/** Structural equality good enough for plain serializable locations
 *  (`{ noteId }`, `{ listId, viewId }`, …). Hosts with a cheaper identity
 *  (a single id string) can pass their own. */
export function defaultNavEquals<L>(a: L, b: L): boolean {
	if (Object.is(a, b)) return true;
	try {
		return JSON.stringify(a) === JSON.stringify(b);
	} catch {
		return false;
	}
}

export function navInit<L>(initial: L): NavHistoryState<L> {
	return { current: initial, back: [], forward: [] };
}

/** Record `next` as the new current: push the old current onto `back`
 *  (capped at `max`, oldest dropped) and clear `forward`. A no-op when
 *  `next` equals the current location. */
export function navTo<L>(
	state: NavHistoryState<L>,
	next: L,
	equals: NavEquals<L> = defaultNavEquals,
	max: number = DEFAULT_MAX,
): NavHistoryState<L> {
	if (equals(next, state.current)) return state;
	const back = [...state.back, state.current];
	return {
		current: next,
		back: back.length > max ? back.slice(back.length - max) : back,
		forward: [],
	};
}

/** Swap the current location without disturbing either stack — for an
 *  ephemeral refinement of "where you are" that shouldn't be its own
 *  history entry (e.g. a selection change inside the same view). */
export function navReplace<L>(
	state: NavHistoryState<L>,
	loc: L,
	equals: NavEquals<L> = defaultNavEquals,
): NavHistoryState<L> {
	if (equals(loc, state.current)) return state;
	return { current: loc, back: state.back, forward: state.forward };
}

export function navBack<L>(state: NavHistoryState<L>): NavHistoryState<L> {
	if (state.back.length === 0) return state;
	const previous = state.back[state.back.length - 1] as L;
	return {
		current: previous,
		back: state.back.slice(0, -1),
		forward: [state.current, ...state.forward],
	};
}

export function navForward<L>(state: NavHistoryState<L>): NavHistoryState<L> {
	if (state.forward.length === 0) return state;
	const next = state.forward[0] as L;
	return {
		current: next,
		back: [...state.back, state.current],
		forward: state.forward.slice(1),
	};
}

export function navCanBack<L>(state: NavHistoryState<L>): boolean {
	return state.back.length > 0;
}

export function navCanForward<L>(state: NavHistoryState<L>): boolean {
	return state.forward.length > 0;
}

export type NavStorage = Pick<Storage, "getItem" | "setItem">;

export type NavPersist<L> = {
	/** localStorage key. Stored value is the full `{current,back,forward}`. */
	key: string;
	/** Defaults to `globalThis.localStorage` when available. */
	storage?: NavStorage;
	/** Reject a restored `current` (e.g. an entity that no longer exists).
	 *  An invalid current collapses persistence to a fresh `navInit`. */
	isValid?: (loc: L) => boolean;
};

export interface NavHistory<L> {
	get(): NavHistoryState<L>;
	current(): L;
	canGoBack(): boolean;
	canGoForward(): boolean;
	/** User navigated to a new location — records it, clears forward. */
	push(loc: L): void;
	/** Refine the current location in place (no new history entry). */
	replace(loc: L): void;
	/** Discard all history and start over at `loc` — for a context change
	 *  where the prior trail is meaningless (a vault switch, sign-out). */
	reset(loc: L): void;
	/** Step back; returns the location to apply, or `null` at the start. */
	back(): L | null;
	/** Step forward; returns the location to apply, or `null` at the end. */
	forward(): L | null;
	/** Fires after any state change. Returns an unsubscribe. */
	subscribe(listener: () => void): () => void;
}

export type CreateNavHistoryOptions<L> = {
	initial: L;
	equals?: NavEquals<L>;
	max?: number;
	persist?: NavPersist<L>;
};

function readPersisted<L>(persist: NavPersist<L>, fallback: L): NavHistoryState<L> {
	const storage = persist.storage ?? safeLocalStorage();
	if (!storage) return navInit(fallback);
	try {
		const raw = storage.getItem(persist.key);
		if (!raw) return navInit(fallback);
		const parsed = JSON.parse(raw) as Partial<NavHistoryState<L>>;
		if (!parsed || !("current" in parsed)) return navInit(fallback);
		const current = parsed.current as L;
		if (persist.isValid && !persist.isValid(current)) return navInit(fallback);
		return {
			current,
			back: Array.isArray(parsed.back) ? (parsed.back as L[]) : [],
			forward: Array.isArray(parsed.forward) ? (parsed.forward as L[]) : [],
		};
	} catch {
		return navInit(fallback);
	}
}

function safeLocalStorage(): NavStorage | null {
	try {
		return globalThis.localStorage ?? null;
	} catch {
		return null;
	}
}

/**
 * The stateful controller. One per app window. Subscribe for re-render
 * (`useNavHistory` does this); call `push` on user navigation; wire
 * `back`/`forward` to the header buttons + the shared chords.
 */
export function createNavHistory<L>(opts: CreateNavHistoryOptions<L>): NavHistory<L> {
	const equals = opts.equals ?? defaultNavEquals;
	const max = opts.max ?? DEFAULT_MAX;
	let state: NavHistoryState<L> = opts.persist
		? readPersisted(opts.persist, opts.initial)
		: navInit(opts.initial);

	const listeners = new Set<() => void>();

	const persistNow = (): void => {
		if (!opts.persist) return;
		const storage = opts.persist.storage ?? safeLocalStorage();
		if (!storage) return;
		try {
			storage.setItem(opts.persist.key, JSON.stringify(state));
		} catch {
			/* quota / private mode — history is best-effort, never fatal */
		}
	};

	const commit = (next: NavHistoryState<L>): void => {
		if (next === state) return;
		state = next;
		persistNow();
		for (const l of listeners) l();
	};

	return {
		get: () => state,
		current: () => state.current,
		canGoBack: () => navCanBack(state),
		canGoForward: () => navCanForward(state),
		push: (loc) => commit(navTo(state, loc, equals, max)),
		replace: (loc) => commit(navReplace(state, loc, equals)),
		reset: (loc) => commit(navInit(loc)),
		back: () => {
			if (!navCanBack(state)) return null;
			commit(navBack(state));
			return state.current;
		},
		forward: () => {
			if (!navCanForward(state)) return null;
			commit(navForward(state));
			return state.current;
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}
