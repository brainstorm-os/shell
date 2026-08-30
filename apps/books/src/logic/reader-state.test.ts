import { describe, expect, it } from "vitest";
import { makeLocator } from "../types/locator";
import { charBudgetPaginator } from "./pagination";
import {
	canGoNext,
	canGoPrev,
	createReaderState,
	currentLocator,
	goToLocator,
	goToPage,
	nextPage,
	pageCount,
	prevPage,
	readingProgress,
	repaginate,
} from "./reader-state";
import { SAMPLE_BOOK_CONTENT } from "./sample-book";

describe("reader navigation", () => {
	it("starts on page 0 with prev disabled", () => {
		const s = createReaderState(SAMPLE_BOOK_CONTENT, charBudgetPaginator(50));
		expect(s.pageIndex).toBe(0);
		expect(canGoPrev(s)).toBe(false);
		expect(canGoNext(s)).toBe(true);
	});

	it("next then prev returns to the same page", () => {
		const start = createReaderState(SAMPLE_BOOK_CONTENT, charBudgetPaginator(50));
		const back = prevPage(nextPage(start));
		expect(back.pageIndex).toBe(start.pageIndex);
	});

	it("cannot advance past the last page", () => {
		let s = createReaderState(SAMPLE_BOOK_CONTENT, charBudgetPaginator(50));
		s = goToPage(s, pageCount(s) - 1);
		expect(canGoNext(s)).toBe(false);
		expect(nextPage(s).pageIndex).toBe(s.pageIndex);
	});

	it("progress measures through the END of the visible page: small on the first, exactly 1 on the last", () => {
		const start = createReaderState(SAMPLE_BOOK_CONTENT, charBudgetPaginator(50));
		// First page covers its 50-char budget of a much longer book.
		expect(readingProgress(start)).toBeGreaterThan(0);
		expect(readingProgress(start)).toBeLessThan(0.1);
		const last = goToPage(start, pageCount(start) - 1);
		expect(readingProgress(last)).toBe(1);
	});

	it("progress grows monotonically page over page", () => {
		let s = createReaderState(SAMPLE_BOOK_CONTENT, charBudgetPaginator(50));
		let previous = 0;
		for (let i = 0; i < pageCount(s); i++) {
			s = goToPage(s, i);
			const p = readingProgress(s);
			expect(p).toBeGreaterThan(previous);
			previous = p;
		}
	});

	it("progress is 0 for an empty book", () => {
		const s = createReaderState({ title: "t", author: "a", spine: [] }, charBudgetPaginator(50));
		expect(readingProgress(s)).toBe(0);
	});

	it("goToLocator jumps to the page holding a locator", () => {
		const s = createReaderState(SAMPLE_BOOK_CONTENT, charBudgetPaginator(50));
		const jumped = goToLocator(s, makeLocator(1, 0));
		const loc = currentLocator(jumped);
		expect(loc?.spineIndex).toBe(1);
	});
});

describe("repaginate keeps the reader on the same words (the headline invariant)", () => {
	it("a smaller budget re-breaks pages but the current locator's spine survives", () => {
		const start = createReaderState(SAMPLE_BOOK_CONTENT, charBudgetPaginator(80));
		const moved = goToLocator(start, makeLocator(1, 40));
		const anchorBefore = currentLocator(moved);
		const reflowed = repaginate(moved, charBudgetPaginator(20));
		const anchorAfter = currentLocator(reflowed);
		// More pages after a smaller budget.
		expect(pageCount(reflowed)).toBeGreaterThan(pageCount(moved));
		// The anchor's spine item is preserved and the new page starts at or
		// before the old anchor (you land back on the same passage).
		expect(anchorAfter?.spineIndex).toBe(anchorBefore?.spineIndex);
		expect(
			anchorAfter && anchorBefore ? anchorAfter.charOffset <= anchorBefore.charOffset : false,
		).toBe(true);
	});
});
