import { PropertyFormat } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { BookFormat } from "../types/book";
import { makeLocator } from "../types/locator";
import { parseBook } from "./book-codec";
import {
	BOOK_PROP_KEY,
	READONLY_BOOK_PROP_KEYS,
	applyBookPropertyValue,
	bookPropertyDefs,
	bookToValues,
} from "./book-properties";

function fixtureBook() {
	const book = parseBook({
		id: "b1",
		name: "Deep Work",
		format: BookFormat.Pdf,
		author: "Cal Newport",
		fileId: "f1",
		spineLength: 12,
		reading: { position: "bkcfi:/4:0", progress: 0.4167, lastReadAt: 1717000000000 },
		createdAt: 1716000000000,
		updatedAt: 1717000000000,
	});
	if (!book) throw new Error("fixture failed to parse");
	return book;
}

describe("bookToValues", () => {
	it("maps author / format label / pages / whole-percent progress fraction", () => {
		const values = bookToValues(fixtureBook());
		expect(values[BOOK_PROP_KEY.author]).toBe("Cal Newport");
		expect(values[BOOK_PROP_KEY.format]).toBe("PDF");
		expect(values[BOOK_PROP_KEY.pages]).toBe(12);
		expect(values[BOOK_PROP_KEY.progress]).toBe(0.42);
	});

	it("hides the page count for a book without a measured spine", () => {
		const book = { ...fixtureBook(), spineLength: 0 };
		expect(bookToValues(book)[BOOK_PROP_KEY.pages]).toBeNull();
	});
});

describe("applyBookPropertyValue", () => {
	it("maps an author edit to a trimmed entity patch", () => {
		expect(applyBookPropertyValue(BOOK_PROP_KEY.author, "  Cal Newport ")).toEqual({
			author: "Cal Newport",
		});
	});

	it("returns null for read-only keys", () => {
		for (const key of READONLY_BOOK_PROP_KEYS) {
			expect(applyBookPropertyValue(key, 99)).toBeNull();
		}
	});
});

describe("bookPropertyDefs", () => {
	// The bare-number cell rendered "45" beside a footer reading "45% read".
	it("formats progress as a percentage over a 0..1 range", () => {
		const def = bookPropertyDefs(BookFormat.Pdf).find((d) => d.key === BOOK_PROP_KEY.progress);
		expect(def?.format).toBe(PropertyFormat.Percent);
		expect(def?.range).toEqual({ min: 0, max: 1 });
	});

	// An EPUB's spine length is its chapter-file count; the reflow reader
	// paginates to the viewport, so "Pages 1" sat beside "Page 2 of 8".
	it("omits the page count for a reflowable EPUB", () => {
		const keys = bookPropertyDefs(BookFormat.Epub).map((d) => d.key);
		expect(keys).not.toContain(BOOK_PROP_KEY.pages);
		expect(keys).toContain(BOOK_PROP_KEY.progress);
	});

	it("declares every value-map key exactly once", () => {
		const keys = bookPropertyDefs(BookFormat.Pdf).map((d) => d.key);
		expect([...keys].sort()).toEqual(Object.values(BOOK_PROP_KEY).sort());
		const values = bookToValues(fixtureBook());
		for (const key of keys) expect(key in values).toBe(true);
	});

	it("parks the reading position the values derive from", () => {
		// Guard the fixture's locator wiring — progress comes from the stored
		// reading blob, not a recomputation.
		expect(fixtureBook().reading.position).toEqual(makeLocator(4, 0));
	});
});
