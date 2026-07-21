/**
 * B9.3 — the `@codemirror/search`-backed find engine. Covers literal /
 * case / whole-word / regex matching, scope restriction, invalid-regex
 * safety, and the one-commit replace-all splice.
 */
import { DEFAULT_FIND_OPTIONS, type FindQuery } from "@brainstorm-os/sdk/find-replace";
import { describe, expect, it } from "vitest";
import { replaceAllInContent, searchCode } from "./find-search";

function query(term: string, options: Partial<typeof DEFAULT_FIND_OPTIONS> = {}): FindQuery {
	return { term, options: { ...DEFAULT_FIND_OPTIONS, ...options } };
}

describe("searchCode", () => {
	it("finds every literal occurrence with absolute offsets", () => {
		const text = "foo bar foo\nbaz foo";
		expect(searchCode(text, query("foo"))).toEqual([
			{ from: 0, to: 3 },
			{ from: 8, to: 11 },
			{ from: 16, to: 19 },
		]);
	});

	it("is case-insensitive by default and case-sensitive on demand", () => {
		const text = "Foo foo FOO";
		expect(searchCode(text, query("foo"))).toHaveLength(3);
		expect(searchCode(text, query("foo", { caseSensitive: true }))).toEqual([{ from: 4, to: 7 }]);
	});

	it("matches across lines for multi-line literal terms", () => {
		const text = "alpha\nbeta\ngamma";
		expect(searchCode(text, query("alpha\nbeta"))).toEqual([{ from: 0, to: 10 }]);
	});

	it("whole-word drops sub-word hits", () => {
		const text = "cat concatenate cat_id cat";
		expect(searchCode(text, query("cat", { wholeWord: true }))).toEqual([
			{ from: 0, to: 3 },
			{ from: 23, to: 26 },
		]);
	});

	it("regex mode matches patterns and reports group-free extents", () => {
		const text = "x1 y22 z333";
		expect(searchCode(text, query("[a-z]\\d+", { regex: true }))).toEqual([
			{ from: 0, to: 2 },
			{ from: 3, to: 6 },
			{ from: 7, to: 11 },
		]);
	});

	it("regex mode honours case sensitivity", () => {
		const text = "Abc abc";
		expect(searchCode(text, query("abc", { regex: true, caseSensitive: true }))).toEqual([
			{ from: 4, to: 7 },
		]);
	});

	it("an invalid / mid-typed regex yields no matches instead of throwing", () => {
		expect(searchCode("anything", query("([", { regex: true }))).toEqual([]);
	});

	it("an empty term yields no matches", () => {
		expect(searchCode("abc", query(""))).toEqual([]);
	});

	it("restricts matches to the given scope", () => {
		const text = "foo foo foo";
		expect(searchCode(text, query("foo"), { from: 3, to: 9 })).toEqual([{ from: 4, to: 7 }]);
	});
});

describe("replaceAllInContent", () => {
	it("replaces every match in one pass and reports the count", () => {
		const result = replaceAllInContent("a-b-a-b", query("b"), "X");
		expect(result).toEqual({ content: "a-X-a-X", count: 2 });
	});

	it("supports shrinking and growing replacements", () => {
		expect(replaceAllInContent("aaa", query("a"), "bb").content).toBe("bbbbbb");
		expect(replaceAllInContent("abcabc", query("abc"), "").content).toBe("");
	});

	it("replacement is literal even in regex mode", () => {
		const result = replaceAllInContent("a1 a2", query("a(\\d)", { regex: true }), "$1!");
		expect(result.content).toBe("$1! $1!");
	});

	it("no matches → identical content, zero count", () => {
		expect(replaceAllInContent("abc", query("zz"), "X")).toEqual({ content: "abc", count: 0 });
	});

	it("scope-restricted replace leaves out-of-scope matches alone", () => {
		const result = replaceAllInContent("foo foo foo", query("foo"), "X", { from: 3, to: 9 });
		expect(result).toEqual({ content: "foo X foo", count: 1 });
	});
});
