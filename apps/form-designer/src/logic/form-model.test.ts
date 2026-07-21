import {
	type AppLayoutManifestEntry,
	LayoutCellKind,
	LayoutContext,
	LayoutMode,
	validateAppLayouts,
	validateLayout,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_TARGET_TYPE,
	buildFormProperties,
	cellsToFields,
	emptyFillFields,
	fieldsToCells,
	fillValuesToProperties,
	formScope,
	isEmptyValue,
	moveField,
	readFormProperties,
	toLayoutDef,
} from "./form-model";

describe("form-model", () => {
	it("builds a stacked, any-context LayoutDef from an ordered field list", () => {
		const props = buildFormProperties({
			name: "  New client  ",
			targetType: "brainstorm/Object/v1",
			fields: [{ property: "name" }, { property: "email", label: "Work email" }],
		});

		expect(props.name).toBe("New client");
		expect(props.mode).toBe(LayoutMode.Stacked);
		expect(props.context).toBeNull();
		expect(props.cells).toHaveLength(2);
		expect(props.cells[0]).toMatchObject({
			kind: LayoutCellKind.Property,
			id: "field-0",
			property: "name",
		});
		expect(props.cells[1]?.display?.options?.label).toBe("Work email");
		expect(props.readingOrder).toEqual(["field-0", "field-1"]);
	});

	it("produces a LayoutDef that passes the contract validator", () => {
		const props = buildFormProperties({
			name: "Bug report",
			targetType: "brainstorm/Object/v1",
			fields: [{ property: "title" }, { property: "severity" }],
		});
		const issues = validateLayout(toLayoutDef(props));
		expect(issues).toEqual([]);
	});

	// 8.10.5: the form's LayoutDef projection must clear the SAME app-shipped
	// layout validator the installer runs (manifest.ts → validateAppLayouts),
	// scoped to the form's target type. This is the round-trip half of the
	// "apply form as a type's default layout" feature — the validation
	// contract closes here; the visible render path is gated on 8.3.
	it("projects a built form that clears validateAppLayouts for its target type", () => {
		const targetType = "io.example/Lead/v1";
		const def = toLayoutDef(
			buildFormProperties({
				name: "New lead",
				targetType,
				fields: [
					{ property: "name" },
					{ property: "email", label: "Work email" },
					{ property: "owner" },
				],
			}),
		);
		const entry: AppLayoutManifestEntry = {
			type: targetType,
			context: null,
			config: { mode: def.mode, cells: def.cells, readingOrder: def.readingOrder ?? [] },
		};
		expect(validateAppLayouts([entry], [targetType])).toEqual([]);
	});

	it("the round-trip projection also clears a context-scoped app layout", () => {
		const targetType = "io.example/Lead/v1";
		const def = toLayoutDef(
			buildFormProperties({ name: "Lead card", targetType, fields: [{ property: "name" }] }),
		);
		const entry: AppLayoutManifestEntry = {
			type: targetType,
			context: LayoutContext.Full,
			config: { mode: def.mode, cells: def.cells, readingOrder: def.readingOrder ?? [] },
		};
		expect(validateAppLayouts([entry], [targetType])).toEqual([]);
	});

	it("round-trips fields → cells → fields, preserving order and labels", () => {
		const fields = [
			{ property: "name" },
			{ property: "due", label: "Due date" },
			{ property: "owner" },
		];
		const cells = fieldsToCells(fields);
		expect(cellsToFields(cells)).toEqual(fields);
	});

	it("drops empty per-field labels when building cells", () => {
		const cells = fieldsToCells([{ property: "name", label: "   " }]);
		expect(cells[0]?.display).toBeUndefined();
		expect(cellsToFields(cells)).toEqual([{ property: "name" }]);
	});

	it("skips non-property cells when reading fields back", () => {
		const fields = cellsToFields([
			{ kind: LayoutCellKind.Property, id: "f0", property: "name" },
			{ kind: LayoutCellKind.Divider, id: "d0" },
			{ kind: LayoutCellKind.Property, id: "f1", property: "" },
		]);
		expect(fields).toEqual([{ property: "name" }]);
	});

	it("scopes a form to its target type", () => {
		expect(formScope("brainstorm/Task/v1")).toEqual({
			kind: "type",
			target: "brainstorm/Task/v1",
		});
	});

	it("reads saved properties tolerantly, defaulting target type + reading order", () => {
		const props = readFormProperties({
			name: "Lead",
			cells: [{ kind: LayoutCellKind.Property, id: "field-0", property: "name" }],
		});
		expect(props.targetType).toBe(DEFAULT_TARGET_TYPE);
		expect(props.readingOrder).toEqual(["field-0"]);
		expect(props.mode).toBe(LayoutMode.Stacked);
	});

	describe("fillValuesToProperties", () => {
		it("maps filled values to entity properties, keyed by property", () => {
			const out = fillValuesToProperties({
				fields: [{ property: "name" }, { property: "email" }, { property: "tags" }],
				values: { name: "Acme", email: "hi@acme.test", tags: ["a", "b"] },
				fallbackName: "Untitled",
			});
			expect(out).toEqual({ name: "Acme", email: "hi@acme.test", tags: ["a", "b"] });
		});

		it("drops null / empty values but keeps a name fallback", () => {
			const out = fillValuesToProperties({
				fields: [{ property: "name" }, { property: "email" }, { property: "tags" }],
				values: { name: "", email: null, tags: [] },
				fallbackName: "Untitled",
			});
			expect(out).toEqual({ name: "Untitled" });
		});

		it("only writes values for fields the form declares", () => {
			const out = fillValuesToProperties({
				fields: [{ property: "name" }],
				values: { name: "Keep", secret: "drop" },
				fallbackName: "Untitled",
			});
			expect(out).toEqual({ name: "Keep" });
		});
	});

	describe("isEmptyValue", () => {
		it("treats nullish, blank strings, and empty arrays as empty", () => {
			expect(isEmptyValue(undefined)).toBe(true);
			expect(isEmptyValue(null)).toBe(true);
			expect(isEmptyValue("")).toBe(true);
			expect(isEmptyValue("   ")).toBe(true);
			expect(isEmptyValue([])).toBe(true);
		});

		it("treats real content as non-empty", () => {
			expect(isEmptyValue("Acme")).toBe(false);
			expect(isEmptyValue(0)).toBe(false);
			expect(isEmptyValue(false)).toBe(false);
			expect(isEmptyValue(["a"])).toBe(false);
		});
	});

	describe("emptyFillFields", () => {
		it("flags every field of a completely empty form (F-239)", () => {
			const fields = [{ property: "name" }, { property: "email" }];
			expect(emptyFillFields({ fields, values: {} })).toEqual(fields);
		});

		it("flags only the blank fields, in document order", () => {
			const empties = emptyFillFields({
				fields: [{ property: "name" }, { property: "email" }, { property: "tags" }],
				values: { email: "hi@acme.test", tags: [] },
			});
			expect(empties).toEqual([{ property: "name" }, { property: "tags" }]);
		});

		it("returns nothing when all fields carry content", () => {
			expect(
				emptyFillFields({
					fields: [{ property: "name" }, { property: "email" }],
					values: { name: "Acme", email: "hi@acme.test" },
				}),
			).toEqual([]);
		});
	});

	describe("moveField (drag-to-reorder + keyboard reorder ordering rule)", () => {
		const f = [{ property: "a" }, { property: "b" }, { property: "c" }, { property: "d" }];

		it("moves a field forward to a later index", () => {
			expect(moveField(f, 0, 2)).toEqual([
				{ property: "b" },
				{ property: "c" },
				{ property: "a" },
				{ property: "d" },
			]);
		});

		it("moves a field backward to an earlier index", () => {
			expect(moveField(f, 3, 1)).toEqual([
				{ property: "a" },
				{ property: "d" },
				{ property: "b" },
				{ property: "c" },
			]);
		});

		it("clamps an out-of-range target to the ends", () => {
			expect(moveField(f, 1, -5).map((x) => x.property)).toEqual(["b", "a", "c", "d"]);
			expect(moveField(f, 1, 99).map((x) => x.property)).toEqual(["a", "c", "d", "b"]);
		});

		it("returns an equal-but-new array for a no-op move", () => {
			const out = moveField(f, 2, 2);
			expect(out).toEqual(f);
			expect(out).not.toBe(f);
		});

		it("returns a copy for an out-of-range source (never mutates input)", () => {
			const out = moveField(f, 9, 0);
			expect(out).toEqual(f);
			expect(out).not.toBe(f);
		});

		it("is pure — the input array is untouched", () => {
			const input = f.slice();
			moveField(input, 0, 3);
			expect(input).toEqual(f);
		});
	});
});
