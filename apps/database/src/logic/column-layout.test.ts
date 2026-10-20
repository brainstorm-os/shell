import { describe, expect, it } from "vitest";
import { ColumnWrap } from "../types/list-view";
import {
	TITLE_COLUMN_ID,
	columnHeaderLabel,
	columnWraps,
	patchColumn,
	propertyColumns,
	setColumnPresentation,
	withTitleColumn,
} from "./column-layout";

const cols = [
	{ propertyId: "a", visible: true },
	{ propertyId: "b", visible: false },
];

describe("column-layout (9.12.29)", () => {
	it("prepends Name when the view never placed it, keeps it where placed otherwise", () => {
		expect(withTitleColumn(cols).map((c) => c.propertyId)).toEqual([TITLE_COLUMN_ID, "a", "b"]);
		const placed = [cols[0], { propertyId: TITLE_COLUMN_ID, visible: true }, cols[1]].filter(
			(c): c is NonNullable<typeof c> => c !== undefined,
		);
		expect(withTitleColumn(placed).map((c) => c.propertyId)).toEqual(["a", TITLE_COLUMN_ID, "b"]);
		expect(propertyColumns(placed).map((c) => c.propertyId)).toEqual(["a", "b"]);
	});

	it("patches Name by materialising it", () => {
		const next = patchColumn(cols, TITLE_COLUMN_ID, { width: 400 });
		expect(next[0]).toEqual({ propertyId: TITLE_COLUMN_ID, visible: true, width: 400 });
		expect(patchColumn(cols, "a", { width: 90 })).toHaveLength(2);
	});

	it("sets and clears presentation keys without residue", () => {
		const aliased = setColumnPresentation(cols, "a", {
			label: "  Alpha ",
			iconOnly: true,
			wrap: ColumnWrap.Wrap,
		});
		expect(aliased[0]).toEqual({
			propertyId: "a",
			visible: true,
			label: "Alpha",
			iconOnly: true,
			wrap: ColumnWrap.Wrap,
		});
		const cleared = setColumnPresentation(aliased, "a", { label: null, iconOnly: false, wrap: null });
		expect(cleared[0]).toEqual({ propertyId: "a", visible: true });
	});

	it("resolves the wrap override and the header label", () => {
		expect(columnWraps({ propertyId: "a", visible: true }, true)).toBe(true);
		expect(columnWraps({ propertyId: "a", visible: true, wrap: ColumnWrap.NoWrap }, true)).toBe(
			false,
		);
		expect(columnWraps({ propertyId: "a", visible: true, wrap: ColumnWrap.Wrap }, false)).toBe(true);
		expect(columnHeaderLabel({ propertyId: "a", visible: true, label: "A" }, "Alpha")).toBe("A");
		expect(columnHeaderLabel({ propertyId: "a", visible: true }, "Alpha")).toBe("Alpha");
	});
});
