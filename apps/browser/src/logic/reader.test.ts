import { describe, expect, it } from "vitest";
import {
	READER_MAX_PARAGRAPHS,
	ReaderPhase,
	type ReaderState,
	canReader,
	readerFor,
	readerParagraphs,
} from "./reader";

describe("readerFor", () => {
	const state: ReaderState = { tabId: "t1", phase: ReaderPhase.Ready, article: null };

	it("returns the state only for its own tab", () => {
		expect(readerFor(state, "t1")).toBe(state);
		expect(readerFor(state, "t2")).toBeNull();
		expect(readerFor(state, null)).toBeNull();
		expect(readerFor(null, "t1")).toBeNull();
	});
});

describe("readerParagraphs", () => {
	it("splits on newline runs, trims, and drops blanks", () => {
		expect(readerParagraphs("one\n\ntwo\n   \nthree  ")).toEqual(["one", "two", "three"]);
	});

	it("caps a newline bomb so the DOM stays bounded", () => {
		const bomb = Array.from({ length: READER_MAX_PARAGRAPHS + 500 }, (_, i) => `p${i}`).join("\n");
		expect(readerParagraphs(bomb)).toHaveLength(READER_MAX_PARAGRAPHS);
	});

	it("returns nothing for whitespace-only text", () => {
		expect(readerParagraphs("  \n \n\t")).toEqual([]);
	});
});

describe("canReader", () => {
	it("allows only http(s) pages", () => {
		expect(canReader("https://example.com/a")).toBe(true);
		expect(canReader("http://example.com/")).toBe(true);
		for (const url of ["about:blank", "brainstorm://x", "not a url", "", undefined]) {
			expect(canReader(url)).toBe(false);
		}
	});
});
