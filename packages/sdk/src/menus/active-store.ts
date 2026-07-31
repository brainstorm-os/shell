/**
 * Module holder for the renderer's active `MenuStore`. The React surfaces
 * reach the store through context (`useMenu`); imperative call sites —
 * `openAnchoredMenu`, the database column-adder, the graph export menu —
 * run outside any React tree and need a handle to the same store the
 * mounted `<BrainstormMenuProvider>` renders from.
 *
 * `BrainstormMenuProvider` publishes its store here on mount and clears it
 * on unmount. One renderer (the shell dashboard, or one sandboxed app) is
 * one module instance, so this is a per-renderer singleton — exactly one
 * store, never shared across renderer processes.
 */

import type { MenuStore } from "@react-fancy-menus/core/runtime";

let active: MenuStore | null = null;
const storeWatchers = new Set<(store: MenuStore | null) => void>();

export function setActiveMenuStore(store: MenuStore | null): void {
	active = store;
	for (const watcher of storeWatchers) watcher(store);
}

/**
 * The mounted store, or null when no `<BrainstormMenuProvider>` is up yet.
 * Imperative openers treat null as "menus unavailable" and fail soft rather
 * than throwing into non-React code paths.
 */
export function getActiveMenuStore(): MenuStore | null {
	return active;
}

/**
 * Observe whether ANY floating popup in this renderer's menu stack is up —
 * menus, typeaheads, search pickers all run through the one store. `onChange`
 * fires on every open⇄closed transition (a menu in its close animation still
 * counts as open, so a quick re-open never flickers the closed state).
 *
 * Host-mount safe: the provider publishes the store asynchronously after
 * `mountMenuHost()`, so this attaches to whatever store is (or later becomes)
 * active rather than requiring one at call time. The consumer that needs this
 * is chrome hosting native-overlaid content (the Browser raises its chrome
 * view above the page `WebContentsView` while a popup is open — DOM that
 * drops into the page region is otherwise painted over natively).
 */
export function watchMenuOpenState(onChange: (open: boolean) => void): () => void {
	let unsubscribe: (() => void) | null = null;
	let last = false;
	const emit = (open: boolean): void => {
		if (open === last) return;
		last = open;
		onChange(open);
	};
	const attach = (store: MenuStore | null): void => {
		unsubscribe?.();
		unsubscribe = null;
		if (!store) {
			emit(false);
			return;
		}
		const read = (): void => emit(store.getAll().length > 0);
		unsubscribe = store.subscribe(read);
		read();
	};
	storeWatchers.add(attach);
	attach(active);
	return () => {
		storeWatchers.delete(attach);
		unsubscribe?.();
		unsubscribe = null;
	};
}
