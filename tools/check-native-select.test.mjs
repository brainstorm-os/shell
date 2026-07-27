/**
 * The native-`<select>` gate. Most of these cases are about NOT firing: a naive
 * grep for `<select` over this repo returns six hits and every one is a false
 * positive, so the false-positive cases below are the ones that decide whether
 * this gate is worth having.
 */

import { describe, expect, it } from "vitest";
import {
	findCreateElementSelect,
	findOffendingUsages,
	stripCommentsAndStrings,
} from "./check-native-select.mjs";

const kinds = (src) => findOffendingUsages(src).map((h) => h.kind);

describe("findOffendingUsages — real violations", () => {
	it("catches a JSX <select>", () => {
		expect(kinds("const x = <select value={v}>\n\t<option/>\n</select>;")).toEqual(["jsx"]);
	});

	it("catches a self-closing and a bare-angle <select>", () => {
		expect(kinds("<select/>")).toEqual(["jsx"]);
		expect(kinds("<select>")).toEqual(["jsx"]);
	});

	it("catches the imperative twin", () => {
		expect(kinds('const el = document.createElement("select");')).toEqual(["createElement"]);
		expect(kinds("document.createElement('select')")).toEqual(["createElement"]);
	});

	it("reports every occurrence, in source order", () => {
		expect(kinds('<select/>\nconst e = document.createElement("select");\n<select >')).toEqual([
			"jsx",
			"createElement",
			"jsx",
		]);
	});
});

describe("findOffendingUsages — the false positives that matter", () => {
	it("ignores prose in a block comment", () => {
		// Verbatim shape from apps/theme-editor and apps/automations.
		expect(kinds("/**\n * a listbox (not a native `<select>`).\n */\nconst a = 1;")).toEqual([]);
	});

	it("ignores prose in a line comment", () => {
		expect(kinds("// a fixed <select> can't do this\nconst a = 1;")).toEqual([]);
	});

	it("ignores a JSX comment expression", () => {
		expect(kinds("{/* a fixed <select> can't. */}")).toEqual([]);
	});

	it("ignores CSS selector lists inside strings", () => {
		// Verbatim shape from packages/sdk/src/app-theme.css's doc comment and the
		// renderer stylesheet: `<input>`/`<textarea>`/`<select>` focus resets.
		expect(kinds('const css = "input, textarea, select { outline: none }";')).toEqual([]);
		expect(kinds("const css = `input,\nselect { color: red }`;")).toEqual([]);
	});

	it("does NOT match the sanctioned replacement", () => {
		// `<SelectMenu>` is the thing this gate pushes people toward — matching it
		// would make the gate self-defeating.
		expect(kinds("<SelectMenu options={o} />")).toEqual([]);
		expect(kinds("<Select />")).toEqual([]);
	});

	it("does not match an element that merely starts with 'select'", () => {
		expect(kinds("<selectable />")).toEqual([]);
	});

	it("does not match createElement for another tag", () => {
		expect(kinds('document.createElement("div")')).toEqual([]);
		expect(kinds('document.createElement("selection")')).toEqual([]);
	});
});

describe("stripCommentsAndStrings", () => {
	it("preserves length and newlines so line numbers stay accurate", () => {
		const src = '// hide\nconst a = "keep";\n<select/>';
		const out = stripCommentsAndStrings(src);
		expect(out).toHaveLength(src.length);
		expect(out.split("\n")).toHaveLength(3);
		// The violation is on line 3 of the original, and must remain so.
		const hit = findOffendingUsages(src)[0];
		expect(src.slice(0, hit.index).split("\n")).toHaveLength(3);
	});

	it("handles escaped quotes without swallowing the rest of the file", () => {
		// A naive scanner ends the string at the escaped quote and then treats real
		// code as string content, silently blinding the gate for the whole file.
		expect(kinds('const s = "a \\" b";\n<select/>')).toEqual(["jsx"]);
	});

	it("leaves an unterminated comment blanked rather than throwing", () => {
		expect(() => stripCommentsAndStrings("/* never closed")).not.toThrow();
	});
});

describe("findCreateElementSelect", () => {
	it("reads RAW source, since the stripper blanks the tag-name literal", () => {
		const raw = 'document.createElement("select")';
		expect(findCreateElementSelect(raw)).toHaveLength(1);
		expect(findCreateElementSelect(stripCommentsAndStrings(raw))).toHaveLength(0);
	});
});
