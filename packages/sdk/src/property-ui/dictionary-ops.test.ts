import type { Dictionary, PropertyDef } from "@brainstorm-os/sdk-types";
import { CARDINALITY_HARD_MAX, ValueType } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	type NoteValues,
	addItem,
	archiveItem,
	deleteItem,
	mergeItems,
	patchItem,
	propertiesForDictionary,
	reorderItem,
	unarchiveItem,
	usageIndex,
} from "./dictionary-ops";

const DICT: Dictionary = {
	id: "dict_status",
	name: "Status",
	items: [
		{ id: "todo", label: "To do", icon: null, sortIndex: 0 },
		{ id: "doing", label: "Doing", icon: null, sortIndex: 1 },
		{ id: "done", label: "Done", icon: null, sortIndex: 2 },
	],
};

const selectProp: PropertyDef = {
	key: "prop_status",
	name: "Status",
	icon: null,
	valueType: ValueType.Text,
	vocabulary: { dictionaryId: "dict_status" },
	count: { min: 0, max: 1 },
};

const multiProp: PropertyDef = {
	key: "prop_tags",
	name: "Tags",
	icon: null,
	valueType: ValueType.Text,
	vocabulary: { dictionaryId: "dict_status" },
	count: { min: 0, max: CARDINALITY_HARD_MAX },
};

describe("dictionary-ops shape edits", () => {
	it("addItem appends with a fresh id + next sortIndex", () => {
		const { dict, item } = addItem(DICT, "New");
		expect(dict.items.length).toBe(4);
		expect(item.sortIndex).toBe(3);
		expect(item.label).toBe("New");
		expect(DICT.items.length).toBe(3); // immutable input
	});

	it("patchItem updates only the matched item", () => {
		const next = patchItem(DICT, "doing", { colour: "#ff0000" });
		expect(next.items.find((i) => i.id === "doing")?.colour).toBe("#ff0000");
		expect(next.items.find((i) => i.id === "todo")?.colour).toBeUndefined();
	});

	it("archive sets archivedAt; unarchive removes it", () => {
		const archived = archiveItem(DICT, "done", 999);
		expect(archived.items.find((i) => i.id === "done")?.archivedAt).toBe(999);
		const back = unarchiveItem(archived, "done");
		expect(back.items.find((i) => i.id === "done")?.archivedAt).toBeUndefined();
	});

	it("reorderItem moves a row and renumbers densely", () => {
		const next = reorderItem(DICT, "done", 0);
		const ordered = [...next.items].sort((a, b) => a.sortIndex - b.sortIndex);
		expect(ordered.map((i) => i.id)).toEqual(["done", "todo", "doing"]);
		expect(ordered.map((i) => i.sortIndex)).toEqual([0, 1, 2]);
	});
});

describe("deleteItem rewrites bound values across notes", () => {
	it("nulls a scalar Select value and filters multi envelopes", () => {
		const notes: NoteValues[] = [
			{ id: "n1", values: { prop_status: "doing" } },
			{ id: "n2", values: { prop_status: "done" } },
			{ id: "n3", values: { prop_tags: [{ value: "doing" }, { value: "done" }] } },
		];
		const { dict, changed } = deleteItem(DICT, "doing", [selectProp, multiProp], notes);
		expect(dict.items.some((i) => i.id === "doing")).toBe(false);
		const byId = new Map(changed.map((c) => [c.id, c.values]));
		expect(byId.get("n1")?.prop_status).toBeUndefined();
		expect(byId.has("n2")).toBe(false); // unaffected
		expect(byId.get("n3")?.prop_tags).toEqual([{ value: "done" }]);
	});
});

describe("mergeItems rewrites + de-dupes", () => {
	it("rewrites the source id to the target, de-duping multi envelopes", () => {
		const notes: NoteValues[] = [
			{ id: "n1", values: { prop_status: "doing" } },
			{ id: "n2", values: { prop_tags: [{ value: "doing" }, { value: "done" }] } },
		];
		const { dict, changed } = mergeItems(
			DICT,
			"doing",
			"done",
			[selectProp, multiProp],
			notes,
			"Done (merged)",
		);
		expect(dict.items.some((i) => i.id === "doing")).toBe(false);
		expect(dict.items.find((i) => i.id === "done")?.label).toBe("Done (merged)");
		const byId = new Map(changed.map((c) => [c.id, c.values]));
		expect(byId.get("n1")?.prop_status).toBe("done");
		// doing→done collapses onto the existing done; no duplicate.
		expect(byId.get("n2")?.prop_tags).toEqual([{ value: "done" }]);
	});
});

describe("usage + property resolution", () => {
	it("propertiesForDictionary filters by vocabulary id", () => {
		const other: PropertyDef = { key: "p2", name: "P2", icon: null, valueType: ValueType.Text };
		expect(
			propertiesForDictionary([selectProp, multiProp, other], "dict_status").map((p) => p.key),
		).toEqual(["prop_status", "prop_tags"]);
	});

	it("usageIndex counts each note once per item across bound props", () => {
		const notes: NoteValues[] = [
			{ id: "n1", values: { prop_status: "doing", prop_tags: [{ value: "doing" }] } },
			{ id: "n2", values: { prop_status: "done" } },
		];
		const idx = usageIndex([selectProp, multiProp], notes);
		expect(idx.get("doing")).toBe(1); // n1, counted once despite two props
		expect(idx.get("done")).toBe(1);
	});
});
