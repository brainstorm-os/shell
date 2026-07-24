import {
	AppLayoutIssueCode,
	LayoutCellKind,
	LayoutContext,
	LayoutMode,
	validateAppLayouts,
	validateLayout,
} from "@brainstorm-os/sdk-types";
import { LayoutResolveSource, resolveLayout } from "@brainstorm-os/sdk/layout-resolver";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_TARGET_TYPE,
	type FormProperties,
	buildFormProperties,
	cellsToFields,
	emptyFillFields,
	fieldsToCells,
	fillValuesToProperties,
	formLayoutIssues,
	formScope,
	isEmptyValue,
	isFormApplicableToType,
	moveField,
	readFormProperties,
	toAppLayoutEntry,
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
		expect(props.scope).toEqual({ kind: "type", target: "brainstorm/Object/v1" });
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
		const props = buildFormProperties({
			name: "New lead",
			targetType,
			fields: [
				{ property: "name" },
				{ property: "email", label: "Work email" },
				{ property: "owner" },
			],
		});
		expect(validateAppLayouts([toAppLayoutEntry(props)], [targetType])).toEqual([]);
	});

	it("toAppLayoutEntry carries the target type, context, and scope-free body", () => {
		const props = buildFormProperties({
			name: "Lead",
			targetType: "io.example/Lead/v1",
			fields: [{ property: "name" }],
		});
		const entry = toAppLayoutEntry(props);
		expect(entry.type).toBe("io.example/Lead/v1");
		expect(entry.context).toBeNull();
		expect(entry.config).toEqual({
			mode: LayoutMode.Stacked,
			cells: props.cells,
			readingOrder: props.readingOrder,
		});
		expect("scope" in entry.config).toBe(false);
	});

	describe("formLayoutIssues / isFormApplicableToType (8.10.5 apply gate)", () => {
		it("a form built through the UI clears the frozen install contract", () => {
			const props = buildFormProperties({
				name: "New lead",
				targetType: "io.example/Lead/v1",
				fields: [{ property: "name" }, { property: "email" }],
			});
			expect(formLayoutIssues(props)).toEqual([]);
			expect(isFormApplicableToType(props)).toBe(true);
		});

		it("delegates to validateLayout — a malformed cell body is rejected", () => {
			const props: FormProperties = {
				name: "Broken",
				mode: LayoutMode.Stacked,
				scope: formScope("io.example/Lead/v1"),
				context: null,
				targetType: "io.example/Lead/v1",
				// two property cells share an id → DuplicateCellId inside the body
				cells: [
					{ kind: LayoutCellKind.Property, id: "dup", property: "name" },
					{ kind: LayoutCellKind.Property, id: "dup", property: "email" },
				],
			};
			const issues = formLayoutIssues(props);
			expect(issues.length).toBeGreaterThan(0);
			expect(issues[0]?.code).toBe(AppLayoutIssueCode.InvalidConfig);
			expect(isFormApplicableToType(props)).toBe(false);
		});

		it("rejects an empty target type (the installer's EmptyType rule)", () => {
			const props = buildFormProperties({
				name: "No type",
				targetType: "",
				fields: [{ property: "name" }],
			});
			// buildFormProperties defaults an empty target type only via the app;
			// the pure model keeps it empty, so the contract flags it.
			expect(
				formLayoutIssues({ ...props, targetType: "" }).some(
					(i) => i.code === AppLayoutIssueCode.EmptyType,
				),
			).toBe(true);
		});
	});

	// 8.10.5 apply-to-type: a saved form is a type-scoped Layout/v1, so the
	// 8.2 resolver returns it as the winning default layout for its target
	// type in any render context. Proven against the REAL resolver (not a
	// re-implementation) — this is the render-side round-trip the visible
	// pipeline (8.3) will consume.
	it("resolves as the type-scoped default layout for its target type", () => {
		const targetType = "io.example/Lead/v1";
		const layout = toLayoutDef(
			buildFormProperties({
				name: "New lead",
				targetType,
				fields: [{ property: "name" }, { property: "email" }],
			}),
		);
		const resolution = resolveLayout(
			{ entityId: "ent_x", types: [targetType], context: LayoutContext.Full },
			[{ layout }],
		);
		expect(resolution.source).toBe(LayoutResolveSource.Scope);
		if (resolution.source === LayoutResolveSource.Scope) {
			expect(resolution.scope).toEqual({ kind: "type", target: targetType });
			expect(resolution.layout).toBe(layout);
		}
	});

	it("does not resolve for an unrelated entity type", () => {
		const layout = toLayoutDef(
			buildFormProperties({
				name: "Lead",
				targetType: "io.example/Lead/v1",
				fields: [{ property: "name" }],
			}),
		);
		const resolution = resolveLayout(
			{ entityId: "ent_y", types: ["brainstorm/Task/v1"], context: LayoutContext.Full },
			[{ layout }],
		);
		expect(resolution.source).toBe(LayoutResolveSource.None);
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
		// Scope is derived from the target type even when the persisted entity
		// predates scope persistence (back-compat with v1 forms).
		expect(props.scope).toEqual({ kind: "type", target: DEFAULT_TARGET_TYPE });
	});

	it("derives scope from the target type, the single source of truth", () => {
		// Even a stale/mismatched persisted scope is ignored — the form's
		// targetType is authoritative, so scope can never drift from it.
		const props = readFormProperties({
			name: "Lead",
			targetType: "io.example/Lead/v1",
			scope: { kind: "type", target: "stale/Type/v1" },
			cells: [],
		});
		expect(props.scope).toEqual({ kind: "type", target: "io.example/Lead/v1" });
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
