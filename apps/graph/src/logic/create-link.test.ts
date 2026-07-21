/**
 * Drag-to-create-link pure-logic tests (9.13.11): gesture classification
 * (rim vs body vs Alt), applicable-def filtering against the vault
 * catalog, and the next-value computation for scalar + multi entityRef
 * properties (overwrite / append / dedupe / capacity).
 */

import { type PropertyDef, ValueType } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	NodeDragKind,
	RELATED_TO_DEF,
	applicableLinkDefs,
	detectDragKind,
	nextRefValue,
} from "./create-link";

function refDef(overrides: Partial<PropertyDef> = {}): PropertyDef {
	return {
		key: "ref1",
		name: "Ref",
		icon: null,
		valueType: ValueType.EntityRef,
		...overrides,
	};
}

describe("detectDragKind", () => {
	it("a press on the disc body moves the node", () => {
		expect(detectDragKind({ distPx: 5, radiusPx: 10, altKey: false })).toBe(NodeDragKind.Move);
	});

	it("a press on the rim (outside the disc, inside the pick slop) starts a link drag", () => {
		expect(detectDragKind({ distPx: 12, radiusPx: 10, altKey: false })).toBe(NodeDragKind.Link);
	});

	it("Alt-drag from anywhere on the node starts a link drag", () => {
		expect(detectDragKind({ distPx: 0, radiusPx: 10, altKey: true })).toBe(NodeDragKind.Link);
	});

	it("the disc boundary itself still moves (rim is strictly outside)", () => {
		expect(detectDragKind({ distPx: 10, radiusPx: 10, altKey: false })).toBe(NodeDragKind.Move);
	});
});

describe("applicableLinkDefs", () => {
	it("keeps only entityRef defs", () => {
		const defs = [
			refDef({ key: "a", name: "A" }),
			{ ...refDef({ key: "t", name: "T" }), valueType: ValueType.Text },
		];
		expect(applicableLinkDefs(defs, "brainstorm/Note/v1").map((d) => d.key)).toEqual(["a"]);
	});

	it("filters by allowedTypes when present; absent/empty allows any target", () => {
		const defs = [
			refDef({ key: "any", name: "Any" }),
			refDef({ key: "empty", name: "Empty", allowedTypes: [] }),
			refDef({ key: "person", name: "Person only", allowedTypes: ["brainstorm/Person/v1"] }),
		];
		expect(applicableLinkDefs(defs, "brainstorm/Note/v1").map((d) => d.key)).toEqual([
			"any",
			"empty",
		]);
		expect(applicableLinkDefs(defs, "brainstorm/Person/v1").map((d) => d.key)).toEqual([
			"any",
			"empty",
			"person",
		]);
	});

	it("sorts by name for a stable menu", () => {
		const defs = [refDef({ key: "z", name: "Zeta" }), refDef({ key: "a", name: "Alpha" })];
		expect(applicableLinkDefs(defs, "x").map((d) => d.name)).toEqual(["Alpha", "Zeta"]);
	});
});

describe("nextRefValue", () => {
	it("scalar def: overwrites the current value", () => {
		expect(nextRefValue(refDef(), "old-id", "new-id")).toBe("new-id");
		expect(nextRefValue(refDef(), null, "new-id")).toBe("new-id");
	});

	it("scalar def: no-op when already pointing at the target", () => {
		expect(nextRefValue(refDef(), "t1", "t1")).toBeNull();
	});

	it("multi def: appends to the existing list", () => {
		const def = refDef({ count: { min: 0, max: 5 } });
		expect(nextRefValue(def, [{ value: "a" }], "b")).toEqual([{ value: "a" }, { value: "b" }]);
		expect(nextRefValue(def, undefined, "b")).toEqual([{ value: "b" }]);
	});

	it("multi def: lifts a legacy scalar value into the list", () => {
		const def = refDef({ count: { min: 0, max: 5 } });
		expect(nextRefValue(def, "a", "b")).toEqual([{ value: "a" }, { value: "b" }]);
	});

	it("multi def: dedupes and respects capacity", () => {
		const def = refDef({ count: { min: 0, max: 2 } });
		expect(nextRefValue(def, [{ value: "a" }], "a")).toBeNull();
		expect(nextRefValue(def, [{ value: "a" }, { value: "b" }], "c")).toBeNull();
	});

	it("multi def: skips malformed entries instead of throwing", () => {
		const def = refDef({ count: { min: 0, max: 5 } });
		expect(nextRefValue(def, [{ value: "a" }, 42, "loose", { nope: 1 }], "b")).toEqual([
			{ value: "a" },
			{ value: "b" },
		]);
	});
});

describe("RELATED_TO_DEF", () => {
	it("is a multi-valued entityRef open to any target type", () => {
		expect(RELATED_TO_DEF.valueType).toBe(ValueType.EntityRef);
		expect(RELATED_TO_DEF.allowedTypes).toBeUndefined();
		expect((RELATED_TO_DEF.count?.max ?? 1) > 1).toBe(true);
		expect(applicableLinkDefs([RELATED_TO_DEF], "anything")).toHaveLength(1);
	});
});
