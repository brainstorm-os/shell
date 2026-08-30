/**
 * Pure reader navigation state — the page cursor + the math to move it and
 * to derive the current locator / progress. The renderer holds one of
 * these and re-paints from it; keeping it pure makes navigation (next /
 * prev / re-paginate-and-stay-put) testable without a DOM and is where the
 * "stay on the same words across a typography change" invariant lives.
 */

import type { Locator } from "../types/locator";
import { type BookContent, type IndexedSpineItem, indexSpine, totalLength } from "./content";
import {
	type Page,
	type Pagination,
	type Paginator,
	clampPageIndex,
	pageIndexForLocator,
	progressAtLocator,
} from "./pagination";

export type ReaderState = {
	spine: IndexedSpineItem[];
	totalChars: number;
	pagination: Pagination;
	pageIndex: number;
};

export function createReaderState(content: BookContent, paginator: Paginator): ReaderState {
	const spine = indexSpine(content);
	const totalChars = totalLength(spine);
	return { spine, totalChars, pagination: paginator(spine), pageIndex: 0 };
}

export function currentPage(state: ReaderState): Page | null {
	return state.pagination.pages[state.pageIndex] ?? null;
}

export function currentLocator(state: ReaderState): Locator | null {
	return currentPage(state)?.range.start ?? null;
}

export function pageCount(state: ReaderState): number {
	return state.pagination.pages.length;
}

export function canGoNext(state: ReaderState): boolean {
	return state.pageIndex < pageCount(state) - 1;
}

export function canGoPrev(state: ReaderState): boolean {
	return state.pageIndex > 0;
}

export function goToPage(state: ReaderState, index: number): ReaderState {
	const pageIndex = clampPageIndex(state.pagination, index);
	if (pageIndex === state.pageIndex) return state;
	return { ...state, pageIndex };
}

export function nextPage(state: ReaderState): ReaderState {
	return goToPage(state, state.pageIndex + 1);
}

export function prevPage(state: ReaderState): ReaderState {
	return goToPage(state, state.pageIndex - 1);
}

export function goToLocator(state: ReaderState, locator: Locator): ReaderState {
	const index = pageIndexForLocator(state.pagination, locator);
	if (index === null) return state;
	return goToPage(state, index);
}

/** Reading progress is measured through the END of the visible page —
 *  "how much of the book have I seen so far" — so the last page reads
 *  exactly 1 (100%) instead of the fraction *preceding* it (F-202: the
 *  start-anchored number showed "Page 2 of 2 · 45% read"). */
export function readingProgress(state: ReaderState): number {
	const page = currentPage(state);
	if (!page) return 0;
	return progressAtLocator(state.spine, state.totalChars, page.range.end);
}

/** Re-paginate against a fresh `Paginator` (a typography or viewport change),
 *  staying on the page that holds the *current* locator. This is the
 *  preview-drop's headline invariant: change the glass, keep your place. */
export function repaginate(state: ReaderState, paginator: Paginator): ReaderState {
	const anchor = currentLocator(state);
	const next: ReaderState = { ...state, pagination: paginator(state.spine), pageIndex: 0 };
	if (!anchor) return next;
	return goToLocator(next, anchor);
}
