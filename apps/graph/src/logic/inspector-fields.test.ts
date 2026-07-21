import { ValueType } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import type { EntityRow } from "./in-memory-graph";
import { editableInspectorFields, inferInspectorDef, inspectorTitle } from "./inspector-fields";

const entity = (properties: Record<string, unknown>): EntityRow => ({
	id: "n1",
	type: "person/v1",
	properties,
	createdAt: 0,
	updatedAt: 0,
	deletedAt: null,
});

describe("inferInspectorDef", () => {
	it("infers Text / Number / Checkbox for scalars", () => {
		expect(inferInspectorDef("city", "Berlin")?.valueType).toBe(ValueType.Text);
		expect(inferInspectorDef("age", 30)?.valueType).toBe(ValueType.Number);
		expect(inferInspectorDef("active", true)?.valueType).toBe(ValueType.Boolean);
	});
	it("skips empty strings, arrays, objects, and non-finite numbers", () => {
		expect(inferInspectorDef("x", "  ")).toBeNull();
		expect(inferInspectorDef("x", [1, 2])).toBeNull();
		expect(inferInspectorDef("x", { a: 1 })).toBeNull();
		expect(inferInspectorDef("x", Number.NaN)).toBeNull();
	});
	it("humanises the key into the def name", () => {
		expect(inferInspectorDef("dueAt", "x")?.name).toBe("Due at");
	});
});

describe("editableInspectorFields", () => {
	it("returns scalar fields, excluding name/title/chrome keys", () => {
		const fields = editableInspectorFields(
			entity({ name: "Alice", city: "Berlin", age: 30, body: "...", members: [1] }),
		);
		expect(fields.map((f) => f.key).sort()).toEqual(["age", "city"]);
	});
	it("skips internal __-prefixed keys and collection plumbing (no seed provenance leak)", () => {
		const fields = editableInspectorFields(
			entity({ name: "foundations", view: "list", __seededBy: "brainstorm-seed", city: "Berlin" }),
		);
		expect(fields.map((f) => f.key)).toEqual(["city"]);
	});
	it("caps at the inspector row limit", () => {
		const props: Record<string, string> = {};
		for (let i = 0; i < 12; i++) props[`p${i}`] = `v${i}`;
		expect(editableInspectorFields(entity(props)).length).toBeLessThanOrEqual(6);
	});
});

describe("inspectorTitle", () => {
	it("reads name then title, empty when unset", () => {
		expect(inspectorTitle(entity({ name: "Alice" }))).toBe("Alice");
		expect(inspectorTitle(entity({ title: "Doc" }))).toBe("Doc");
		expect(inspectorTitle(entity({}))).toBe("");
	});
});
