// @vitest-environment jsdom
/**
 * `watchMenuOpenState` — the popup-open observable chrome uses to coordinate
 * with natively-overlaid content (the Browser raises its chrome view above
 * the page `WebContentsView` while any popup is up). Must survive the store
 * being published AFTER the watcher attaches (the provider mounts async),
 * and must only fire on open⇄closed transitions.
 */

import { MenuStore } from "@react-fancy-menus/core/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getActiveMenuStore, setActiveMenuStore, watchMenuOpenState } from "./active-store";
import { CONTEXT_MENU_ID, contextMenuConfig } from "./context-menu";

function freshStore(): MenuStore {
	const store = new MenuStore();
	store.register(contextMenuConfig);
	return store;
}

afterEach(() => {
	setActiveMenuStore(null);
	vi.useRealTimers();
});

describe("watchMenuOpenState", () => {
	it("emits open/closed transitions from the active store", () => {
		vi.useFakeTimers();
		const store = freshStore();
		setActiveMenuStore(store);
		const seen: boolean[] = [];
		const stop = watchMenuOpenState((open) => seen.push(open));

		store.open(CONTEXT_MENU_ID, { data: { items: [] } });
		expect(seen).toEqual([true]);

		store.closeAll();
		// A closing menu still counts as open until its exit animation ends —
		// a fast re-open must never flicker the closed state through.
		vi.runAllTimers();
		expect(seen).toEqual([true, false]);
		stop();
	});

	it("attaches to a store published after the watcher (async host mount)", () => {
		vi.useFakeTimers();
		const seen: boolean[] = [];
		const stop = watchMenuOpenState((open) => seen.push(open));
		expect(seen).toEqual([]);

		const store = freshStore();
		setActiveMenuStore(store);
		store.open(CONTEXT_MENU_ID, { data: { items: [] } });
		expect(seen).toEqual([true]);
		stop();
	});

	it("does not repeat the current state and stops emitting after dispose", () => {
		vi.useFakeTimers();
		const store = freshStore();
		setActiveMenuStore(store);
		const seen: boolean[] = [];
		const stop = watchMenuOpenState((open) => seen.push(open));

		store.open(CONTEXT_MENU_ID, { data: { items: [] } });
		store.update(CONTEXT_MENU_ID, {});
		expect(seen).toEqual([true]);

		stop();
		store.closeAll();
		vi.runAllTimers();
		expect(seen).toEqual([true]);
		expect(getActiveMenuStore()).toBe(store);
	});
});
