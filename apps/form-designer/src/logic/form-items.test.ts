import { ChromeKind, LayoutCellKind, LayoutMode, validateLayout } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	FormItemKind,
	cellsToItems,
	chromeItem,
	fieldItem,
	groupItem,
	itemFields,
	itemsContainProperty,
	itemsToCells,
	moveFieldIntoGroup,
	moveFieldOutOfGroup,
	moveItem,
} from "./form-items";
import { DEFAULT_TARGET_TYPE, buildFormProperties, toLayoutDef } from "./form-model";

const f = (property: string) => fieldItem({ property });

describe("itemFields", () => {
	it("flattens grouped fields into document order — a group is presentation, not a boundary", () => {
		const items = [
			f("a"),
			groupItem({ id: "g1", label: "Contact", fields: [{ property: "b" }, { property: "c" }] }),
			f("d"),
		];
		expect(itemFields(items).map((field) => field.property)).toEqual(["a", "b", "c", "d"]);
	});

	it("ignores chrome cells — they carry no value", () => {
		const items = [f("a"), chromeItem({ id: "c1", chrome: ChromeKind.ActionBar })];
		expect(itemFields(items).map((field) => field.property)).toEqual(["a"]);
	});

	it("finds a property wherever it sits", () => {
		const items = [groupItem({ id: "g1", fields: [{ property: "nested" }] })];
		expect(itemsContainProperty(items, "nested")).toBe(true);
		expect(itemsContainProperty(items, "elsewhere")).toBe(false);
	});
});

describe("itemsToCells", () => {
	it("emits one cell per item, with its kind", () => {
		const cells = itemsToCells([
			f("a"),
			groupItem({ id: "g1", label: "Contact", fields: [{ property: "b" }] }),
			chromeItem({ id: "c1", chrome: ChromeKind.Meta }),
		]);
		expect(cells.map((cell) => cell.kind)).toEqual([
			LayoutCellKind.Property,
			LayoutCellKind.Group,
			LayoutCellKind.Chrome,
		]);
	});

	it("gives every cell — including nested ones — a unique stable id", () => {
		const cells = itemsToCells([
			f("a"),
			groupItem({ id: "g1", fields: [{ property: "b" }, { property: "c" }] }),
		]);
		const group = cells[1];
		expect(cells[0]?.id).toBe("field-0");
		expect(group?.id).toBe("g1");
		expect(group?.kind === LayoutCellKind.Group ? group.cells.map((c) => c.id) : []).toEqual([
			"group-1-field-0",
			"group-1-field-1",
		]);
	});

	it("a flat form keeps the pre-8.10.3 ids, so old saves round-trip unchanged", () => {
		expect(itemsToCells([f("a"), f("b")]).map((cell) => cell.id)).toEqual(["field-0", "field-1"]);
	});

	it("carries a group's label and its own mode", () => {
		const cells = itemsToCells([
			groupItem({ id: "g1", label: "Contact", mode: LayoutMode.Grid, fields: [{ property: "b" }] }),
		]);
		const group = cells[0];
		expect(group).toMatchObject({ label: "Contact", mode: LayoutMode.Grid });
	});

	it("places only top-level cells — a group's children flow inside it", () => {
		const cells = itemsToCells(
			[f("a"), groupItem({ id: "g1", fields: [{ property: "b" }] })],
			(index) => ({
				col: index + 1,
				row: 1,
			}),
		);
		expect(cells[0]?.grid).toEqual({ col: 1, row: 1 });
		const group = cells[1];
		expect(group?.grid).toEqual({ col: 2, row: 1 });
		expect(group?.kind === LayoutCellKind.Group ? group.cells[0]?.grid : "x").toBeUndefined();
	});
});

describe("cellsToItems", () => {
	it("round-trips fields, groups and chrome", () => {
		const items = [
			f("a"),
			groupItem({ id: "g1", label: "Contact", fields: [{ property: "b" }] }),
			chromeItem({ id: "c1", chrome: ChromeKind.Breadcrumb }),
		];
		const back = cellsToItems(itemsToCells(items));
		expect(back).toEqual(items);
	});

	it("flattens a group nested inside a group instead of losing its fields", () => {
		const back = cellsToItems([
			{
				kind: LayoutCellKind.Group,
				id: "g",
				label: "Outer",
				cells: [
					{ kind: LayoutCellKind.Property, id: "g-0", property: "a" },
					{
						kind: LayoutCellKind.Group,
						id: "g-1",
						cells: [{ kind: LayoutCellKind.Property, id: "g-1-0", property: "b" }],
					},
				],
			},
		]);
		expect(back).toHaveLength(1);
		expect(itemFields(back).map((field) => field.property)).toEqual(["a", "b"]);
	});

	it("skips cell kinds the builder has no surface for", () => {
		const back = cellsToItems([
			{ kind: LayoutCellKind.Text, id: "t", text: "hi" },
			{ kind: LayoutCellKind.Divider, id: "d" },
			{ kind: LayoutCellKind.Property, id: "p", property: "a" },
		]);
		expect(back).toHaveLength(1);
		expect(back[0]?.kind).toBe(FormItemKind.Field);
	});

	it("drops a chrome cell with an unknown kind rather than trusting it", () => {
		const back = cellsToItems([
			{ kind: LayoutCellKind.Chrome, id: "c", chrome: "burndownBar" } as never,
		]);
		expect(back).toEqual([]);
	});
});

describe("nesting moves", () => {
	const items = [f("a"), groupItem({ id: "g1", label: "G", fields: [] }), f("b")];

	it("moves a field into the group above it", () => {
		const next = moveFieldIntoGroup(items, 2, 1);
		expect(next).toHaveLength(2);
		expect(itemFields(next).map((field) => field.property)).toEqual(["a", "b"]);
		const group = next[1];
		expect(group?.kind === FormItemKind.Group ? group.group.fields.length : 0).toBe(1);
	});

	it("lifts a field back out, directly after its group", () => {
		const nested = moveFieldIntoGroup(items, 2, 1);
		const back = moveFieldOutOfGroup(nested, 1, 0);
		expect(back.map((item) => item.kind)).toEqual([
			FormItemKind.Field,
			FormItemKind.Group,
			FormItemKind.Field,
		]);
		expect(itemFields(back).map((field) => field.property)).toEqual(["a", "b"]);
	});

	it("refuses a target that is not a group, and a source that is not a field", () => {
		expect(moveFieldIntoGroup(items, 0, 2)).toEqual(items);
		expect(moveFieldIntoGroup(items, 1, 1)).toEqual(items);
		expect(moveFieldOutOfGroup(items, 0, 0)).toEqual(items);
		expect(moveFieldOutOfGroup(items, 1, 5)).toEqual(items);
	});

	it("moveItem reorders top-level items and clamps out-of-range targets", () => {
		expect(moveItem(items, 2, 0).map((i) => i.kind)).toEqual([
			FormItemKind.Field,
			FormItemKind.Field,
			FormItemKind.Group,
		]);
		expect(moveItem(items, 0, 99)[2]?.kind).toBe(FormItemKind.Field);
		expect(moveItem(items, 5, 0)).toEqual(items);
	});
});

describe("a form with groups + chrome is a valid layout", () => {
	it("validates through the frozen contract", () => {
		const props = buildFormProperties({
			name: "Person",
			targetType: DEFAULT_TARGET_TYPE,
			items: [
				chromeItem({ id: "c1", chrome: ChromeKind.EntityHeader }),
				f("name"),
				groupItem({
					id: "g1",
					label: "Contact",
					fields: [{ property: "email" }, { property: "phone" }],
				}),
				chromeItem({ id: "c2", chrome: ChromeKind.Meta }),
			],
		});
		expect(validateLayout(toLayoutDef(props))).toEqual([]);
	});

	it("the readingOrder covers the top level; nested ids come from the group", () => {
		const props = buildFormProperties({
			name: "Person",
			targetType: DEFAULT_TARGET_TYPE,
			items: [f("name"), groupItem({ id: "g1", fields: [{ property: "email" }] })],
		});
		// An explicit readingOrder must be a permutation of EVERY cell id, so
		// a partial one would be a validation failure — proving the contract
		// and the builder agree on what ids exist.
		expect(validateLayout(toLayoutDef(props))).toEqual([]);
	});
});
