import type { PropertyDef } from "@brainstorm/sdk-types";
import { ValueType } from "@brainstorm/sdk-types";
import { describe, expect, it } from "vitest";
import type { ScopedList } from "./list-scoped-properties";
import { inheritedPropertyDefs, listsContainingEntity } from "./list-scoped-properties";

const def = (key: string, target?: string): PropertyDef => ({
	key,
	name: key,
	icon: null,
	valueType: ValueType.Text,
	...(target ? { scope: { kind: "list" as const, target } } : {}),
});

const list = (id: string, include: string[], exclude: string[] = []): ScopedList => ({
	id,
	members: {
		include: include.map((entityId) => ({ entityId })),
		exclude: exclude.map((entityId) => ({ entityId })),
	},
});

describe("listsContainingEntity", () => {
	it("returns manual-member lists in stable id order", () => {
		const lists = [list("zeta", ["book1"]), list("alpha", ["book1", "book2"])];
		expect(listsContainingEntity("book1", lists)).toEqual(["alpha", "zeta"]);
		expect(listsContainingEntity("book2", lists)).toEqual(["alpha"]);
	});

	it("exclude wins over include", () => {
		const lists = [list("horror", ["book1"], ["book1"])];
		expect(listsContainingEntity("book1", lists)).toEqual([]);
	});

	it("is empty for a non-member", () => {
		expect(listsContainingEntity("ghost", [list("horror", ["book1"])])).toEqual([]);
	});
});

describe("inheritedPropertyDefs", () => {
	const catalog = [
		def("rating", "horror"),
		def("subgenre", "horror"),
		def("global"), // unscoped — never inherited
		def("mood", "fantasy"),
	];

	it("inherits the scoped defs of every collection the entity belongs to", () => {
		const lists = [list("horror", ["book1"]), list("fantasy", ["book1"])];
		const keys = inheritedPropertyDefs("book1", lists, catalog).map((d) => d.key);
		expect(keys).toEqual(["mood", "rating", "subgenre"]); // fantasy(alpha) before horror
	});

	it("ignores unscoped defs and lists the entity isn't in", () => {
		const lists = [list("horror", ["book1"]), list("fantasy", ["book2"])];
		const keys = inheritedPropertyDefs("book1", lists, catalog).map((d) => d.key);
		expect(keys).toEqual(["rating", "subgenre"]);
		expect(keys).not.toContain("global");
		expect(keys).not.toContain("mood");
	});

	it("dedupes a key defined by two collections — first list (id order) wins", () => {
		const dup = [def("rating", "horror"), { ...def("rating", "aaa"), name: "AAA rating" }];
		const lists = [list("horror", ["b"]), list("aaa", ["b"])];
		const defs = inheritedPropertyDefs("b", lists, dup);
		expect(defs.map((d) => d.key)).toEqual(["rating"]);
		expect(defs[0]?.name).toBe("AAA rating"); // "aaa" sorts before "horror"
	});

	it("returns [] when the entity is in no scoping collection", () => {
		expect(inheritedPropertyDefs("book1", [], catalog)).toEqual([]);
		expect(inheritedPropertyDefs("book1", [list("empty", ["other"])], catalog)).toEqual([]);
	});

	it("accepts the catalog as a keyed record too", () => {
		const record = { rating: def("rating", "horror"), global: def("global") };
		const keys = inheritedPropertyDefs("b", [list("horror", ["b"])], record).map((d) => d.key);
		expect(keys).toEqual(["rating"]);
	});
});
