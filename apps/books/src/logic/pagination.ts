/**
 * Pure pagination over the indexed content stream. Reflow page breaks are
 * a function of (content, chars-per-page budget) — the budget is what the
 * renderer derives from font size × viewport, so re-pagination on a
 * typography change is just a recompute with a new budget while locators
 * stay valid. Each page is a `LocatorRange`; the model maps locator↔page
 * both ways. This is the long-term keystone (it outlives the preview
 * renderer); the real reader feeds it measured budgets from epub.js.
 */

import { type Locator, type LocatorRange, compareLocators, makeLocator } from "../types/locator";
import type { IndexedSpineItem } from "./content";

export type Page = {
	index: number;
	range: LocatorRange;
};

export type Pagination = {
	pages: Page[];
	totalChars: number;
};

/** Compute page breaks. Pages never span spine items (a chapter always
 *  starts a new page) and each page holds up to `charsPerPage` characters.
 *  An empty spine item still yields one (empty) page so the chapter is
 *  reachable. */
export function paginate(spine: IndexedSpineItem[], charsPerPage: number): Pagination {
	const budget = Math.max(1, Math.floor(charsPerPage));
	const pages: Page[] = [];
	let totalChars = 0;
	spine.forEach((s, spineIndex) => {
		totalChars += s.length;
		if (s.length === 0) {
			pages.push({
				index: pages.length,
				range: { start: makeLocator(spineIndex, 0), end: makeLocator(spineIndex, 0) },
			});
			return;
		}
		for (let offset = 0; offset < s.length; offset += budget) {
			const end = Math.min(offset + budget, s.length);
			pages.push({
				index: pages.length,
				range: {
					start: makeLocator(spineIndex, offset),
					end: makeLocator(spineIndex, end),
				},
			});
		}
	});
	return { pages, totalChars };
}

/** How a `ReaderState` turns content into pages. The reflow reader supplies a
 *  layout-measured one (`paginateMeasured` bound to freshly measured block
 *  geometry); the char-budget one below stays for content that has no rendered
 *  geometry to measure — tests, and the first paint before the ruler has run. */
export type Paginator = (spine: IndexedSpineItem[]) => Pagination;

/** The original character-budget strategy as a `Paginator`. Approximate by
 *  construction — it cannot see ragged line ends or paragraph margins — so it
 *  is a fallback, never the reading path. */
export function charBudgetPaginator(charsPerPage: number): Paginator {
	return (spine) => paginate(spine, charsPerPage);
}

/** True when `locator` falls within `page.range` (start-inclusive,
 *  end-exclusive). A locator sitting exactly on a page break belongs to the
 *  next page, not this one — `pageIndexForLocator` resolves that boundary. */
function pageContains(page: Page, locator: Locator): boolean {
	const afterStart = compareLocators(locator, page.range.start) >= 0;
	const beforeEnd = compareLocators(locator, page.range.end) < 0;
	return afterStart && beforeEnd;
}

/** The page index a locator lands on, or `null` if it's out of range.
 *  Prefers the page that *contains* the locator over the boundary page
 *  whose end equals it (so a position at a page break shows the new page). */
export function pageIndexForLocator(pagination: Pagination, locator: Locator): number | null {
	let boundaryMatch: number | null = null;
	for (const page of pagination.pages) {
		const beforeEnd = compareLocators(locator, page.range.end) < 0;
		const afterStart = compareLocators(locator, page.range.start) >= 0;
		if (afterStart && beforeEnd) return page.index;
		if (afterStart && compareLocators(locator, page.range.end) === 0) {
			boundaryMatch = page.index;
		}
	}
	if (boundaryMatch !== null) return boundaryMatch;
	// Out of range below the first page: clamp to 0; above the last: clamp to last.
	if (pagination.pages.length === 0) return null;
	const first = pagination.pages[0];
	const last = pagination.pages[pagination.pages.length - 1];
	if (first && compareLocators(locator, first.range.start) < 0) return 0;
	if (last && compareLocators(locator, last.range.end) >= 0) return last.index;
	return null;
}

export { pageContains };

/** Clamp a page index into `[0, pages.length - 1]`. */
export function clampPageIndex(pagination: Pagination, index: number): number {
	if (pagination.pages.length === 0) return 0;
	if (index < 0) return 0;
	if (index >= pagination.pages.length) return pagination.pages.length - 1;
	return index;
}

/** Reading progress (0..1) at the start of a given page — the fraction of
 *  the book's characters that precede it. */
export function progressAtLocator(
	spine: IndexedSpineItem[],
	totalChars: number,
	locator: Locator,
): number {
	if (totalChars === 0) return 0;
	let preceding = 0;
	for (let i = 0; i < locator.spineIndex && i < spine.length; i++) {
		const s = spine[i];
		if (s) preceding += s.length;
	}
	preceding += Math.max(0, locator.charOffset);
	return Math.min(1, Math.max(0, preceding / totalChars));
}
