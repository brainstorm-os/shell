/**
 * The private-entity-title gate. The cases that decide whether it is worth
 * having are the ones where it must NOT fire: a single-key read of a type
 * the file owns, and the exclusion lists / doc comments that name the same
 * keys as data rather than as a chain.
 */

import { describe, expect, it } from "vitest";
import { ENTITY_TITLE_KEYS } from "../packages/sdk/src/entity-title";
import { TITLE_KEYS, findPrivateResolvers } from "./check-entity-title.mjs";

const keysAt = (src) => findPrivateResolvers(src).map((h) => h.keys);

describe("the gate's key list tracks the shared chain", () => {
	it("mirrors ENTITY_TITLE_KEYS exactly", () => {
		// A key added to the resolver but not here would go unpoliced.
		expect(TITLE_KEYS).toEqual([...ENTITY_TITLE_KEYS]);
	});
});

describe("findPrivateResolvers — real violations", () => {
	it("catches a `??` chain", () => {
		expect(keysAt("const raw = props.title ?? props.name;")).toEqual([["name", "title"]]);
	});

	it("catches a `||`-of-coercions chain", () => {
		expect(keysAt("const n = str(props.name) || str(props.title) || str(props.label);")).toEqual([
			["label", "name", "title"],
		]);
	});

	it("catches a multi-line typeof ladder", () => {
		const src = [
			"function f(e) {",
			'\tif (typeof e.properties.title === "string") return e.properties.title;',
			'\tif (typeof e.properties.name === "string") return e.properties.name;',
			'\treturn "";',
			"}",
		].join("\n");
		expect(keysAt(src)).toEqual([["name", "title"]]);
	});

	it("catches bracket access", () => {
		expect(keysAt('const v = properties["title"] ?? properties["displayName"];')).toEqual([
			["displayName", "title"],
		]);
	});

	it("reports the first line of the offending window", () => {
		expect(findPrivateResolvers("const a = 1;\nconst v = p.title ?? p.name;")[0]?.line).toBe(2);
	});
});

describe("findPrivateResolvers — the false positives that matter", () => {
	it("ignores a single-key read of a type the file owns", () => {
		// `Whiteboard/v1`'s schema requires `name`; that is not a chain.
		expect(keysAt('const name = str(props.name) || "Untitled board";')).toEqual([]);
	});

	it("ignores keys named only in a doc comment", () => {
		expect(
			keysAt("/** Reads `props.title`, then `props.name`. */\nconst x = resolveEntityTitle(p);"),
		).toEqual([]);
	});

	it("ignores keys named only in a line comment", () => {
		expect(keysAt("// title then name\nconst x = 1;")).toEqual([]);
	});

	it("ignores a string-literal exclusion list", () => {
		// apps/database's inspector hides the keys it paints as the heading.
		expect(keysAt('const SKIP = new Set(["title", "name", "cover"]);')).toEqual([]);
	});

	it("ignores unrelated `.name` on non-property objects", () => {
		expect(keysAt("const detail = `${error.name}: ${error.message}`;\nconst t = def.title;")).toEqual(
			[],
		);
	});

	it("ignores two title-ish keys separated by more than the window", () => {
		const src = ["const a = props.title;", ...Array(8).fill("// filler"), "const b = props.name;"];
		expect(keysAt(src.join("\n"))).toEqual([]);
	});
});
