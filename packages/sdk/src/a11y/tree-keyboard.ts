/**
 * `@brainstorm-os/sdk/a11y` tree-walk controller — the pure half of
 * `useTreeKeyboard`. The caller flattens its visible tree into an array
 * (nodes inside a collapsed parent are omitted); the controller walks that
 * array and emits collapse / expand toggles via a callback. This keeps the
 * controller agnostic to where the tree lives (in-memory, async-loaded, on
 * disk).
 *
 * Tree-pattern keys per `61-keyboard-accessibility.md`:
 *   Next / Previous → flat-array walk, skipping disabled.
 *   Home / End      → first / last non-disabled in the visible array.
 *   Collapse        → on expanded parent: onToggle(id, false) (caller
 *                     rehydrates the flat array);
 *                     on collapsed node / leaf: move to parent (no-op at root).
 *   Expand          → on collapsed parent: onToggle(id, true) (caller
 *                     rehydrates);
 *                     on expanded parent: move to first child;
 *                     on leaf: no-op.
 *   Both toggles are callback-only — the host is the single source of truth
 *   for `expanded` and the visible flat array. An earlier shape mutated
 *   `state.nodes` in place for Collapse but not Expand; the asymmetry stranded
 *   stale grandchildren in the controller until the host re-fed nodes.
 *   Activate        → no-op on state — intent only; the host wires it.
 */

export type TreeNode = {
	readonly id: string;
	readonly level: number;
	readonly parentId: string | null;
	readonly expanded: boolean;
	readonly disabled?: boolean;
	/** Optional: when the visible flat array doesn't include children yet
	 *  (lazy loading), set this to `true` so Collapse/Expand can disambiguate
	 *  a "parent with not-yet-loaded children" from a leaf. Falls back to the
	 *  flat-array heuristic (next-sibling-is-child) when absent. */
	readonly hasChildren?: boolean;
};

export type TreeState = {
	readonly activeId: string | null;
	readonly nodes: ReadonlyArray<TreeNode>;
};

export enum TreeKey {
	Next = "next",
	Previous = "previous",
	Home = "home",
	End = "end",
	Collapse = "collapse",
	Expand = "expand",
	/**
	 * Activate (Enter / Space) is a no-op on `TreeState` by design — there is
	 * no movement to record and no toggle to emit. The reducer can't surface a
	 * side-channel from an unchanged state, so `useTreeKeyboard` watches the
	 * inbound key itself and fires `onActivate(id)` before dispatching: the
	 * hook layer owns the asymmetry, not the reducer.
	 */
	Activate = "activate",
}

export type TreeKeyContext = {
	onToggle?: (id: string, expanded: boolean) => void;
};

function findFirstEnabled(nodes: ReadonlyArray<TreeNode>): string | null {
	for (const n of nodes) {
		if (!n.disabled) return n.id;
	}
	return null;
}

function findLastEnabled(nodes: ReadonlyArray<TreeNode>): string | null {
	for (let i = nodes.length - 1; i >= 0; i--) {
		const n = nodes[i] as TreeNode;
		if (!n.disabled) return n.id;
	}
	return null;
}

export function treeInit(nodes: ReadonlyArray<TreeNode>, activeId?: string | null): TreeState {
	const resolvedActive =
		activeId !== undefined && activeId !== null && nodes.some((n) => n.id === activeId)
			? activeId
			: findFirstEnabled(nodes);
	return Object.freeze({ activeId: resolvedActive, nodes });
}

function indexOf(nodes: ReadonlyArray<TreeNode>, id: string | null): number {
	if (id === null) return -1;
	for (let i = 0; i < nodes.length; i++) {
		if ((nodes[i] as TreeNode).id === id) return i;
	}
	return -1;
}

function withActive(state: TreeState, activeId: string | null): TreeState {
	if (state.activeId === activeId) return state;
	return Object.freeze({ ...state, activeId });
}

function hasChildren(nodes: ReadonlyArray<TreeNode>, parentIdx: number): boolean {
	const parent = nodes[parentIdx] as TreeNode;
	// Explicit flag wins so lazy-loaded trees (the flat array hasn't fetched
	// the children yet) still distinguish "parent with hidden children" from
	// "leaf" — without it, an expanded parent whose children aren't in the
	// array would be treated as a leaf and Collapse would jump to grandparent.
	if (parent.hasChildren !== undefined) return parent.hasChildren;
	const next = nodes[parentIdx + 1];
	return next !== undefined && next.parentId === parent.id;
}

function moveNext(state: TreeState): TreeState {
	const { nodes } = state;
	if (nodes.length === 0) return state;
	const start = indexOf(nodes, state.activeId);
	for (let i = start + 1; i < nodes.length; i++) {
		const n = nodes[i] as TreeNode;
		if (!n.disabled) return withActive(state, n.id);
	}
	return state;
}

function movePrevious(state: TreeState): TreeState {
	const { nodes } = state;
	if (nodes.length === 0) return state;
	const start = indexOf(nodes, state.activeId);
	const from = start < 0 ? nodes.length - 1 : start - 1;
	for (let i = from; i >= 0; i--) {
		const n = nodes[i] as TreeNode;
		if (!n.disabled) return withActive(state, n.id);
	}
	return state;
}

function home(state: TreeState): TreeState {
	const next = findFirstEnabled(state.nodes);
	return next === null ? state : withActive(state, next);
}

function end(state: TreeState): TreeState {
	const next = findLastEnabled(state.nodes);
	return next === null ? state : withActive(state, next);
}

function collapse(state: TreeState, ctx: TreeKeyContext | undefined): TreeState {
	if (state.activeId === null) return state;
	const idx = indexOf(state.nodes, state.activeId);
	if (idx < 0) return state;
	const node = state.nodes[idx] as TreeNode;
	const isParent = hasChildren(state.nodes, idx);
	if (isParent && node.expanded) {
		ctx?.onToggle?.(node.id, false);
		return state;
	}
	if (node.parentId === null) return state;
	return withActive(state, node.parentId);
}

function expand(state: TreeState, ctx: TreeKeyContext | undefined): TreeState {
	if (state.activeId === null) return state;
	const idx = indexOf(state.nodes, state.activeId);
	if (idx < 0) return state;
	const node = state.nodes[idx] as TreeNode;
	const isParent = hasChildren(state.nodes, idx);
	if (isParent && node.expanded) {
		const next = state.nodes[idx + 1];
		if (next !== undefined) return withActive(state, next.id);
		return state;
	}
	if (!node.expanded) {
		// Collapsed node OR a leaf marked unexpanded. Distinguishing them
		// requires data the controller doesn't have (post-collapse flat array
		// removes the children); the convention is the host knows from the
		// node metadata whether it CAN expand. We always emit the toggle —
		// the host MAY drop it on a leaf. This mirrors `react-aria`'s
		// `useTreeState` shape.
		ctx?.onToggle?.(node.id, true);
		return state;
	}
	return state;
}

export function treeKey(state: TreeState, key: TreeKey, ctx?: TreeKeyContext): TreeState {
	switch (key) {
		case TreeKey.Next:
			return moveNext(state);
		case TreeKey.Previous:
			return movePrevious(state);
		case TreeKey.Home:
			return home(state);
		case TreeKey.End:
			return end(state);
		case TreeKey.Collapse:
			return collapse(state, ctx);
		case TreeKey.Expand:
			return expand(state, ctx);
		case TreeKey.Activate:
			return state;
	}
}
