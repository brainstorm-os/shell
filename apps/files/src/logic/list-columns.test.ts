import { describe, expect, it } from "vitest";
import {
	DEFAULT_LIST_COLUMNS,
	ListColumn,
	isListColumn,
	listIconTrack,
	parseListColumns,
	toggleListColumn,
} from "./list-columns";

describe("list columns (9.8.11)", () => {
	it("parses a stored order, dropping junk and duplicates", () => {
		expect(parseListColumns(["size", "kind", "size", "bogus"])).toEqual([
			ListColumn.Size,
			ListColumn.Kind,
		]);
		expect(parseListColumns("nope")).toEqual(DEFAULT_LIST_COLUMNS);
		expect(parseListColumns([])).toEqual([]);
	});

	it("toggle removes in place and appends on re-enable (order = chosen order)", () => {
		const without = toggleListColumn(DEFAULT_LIST_COLUMNS, ListColumn.Kind);
		expect(without).toEqual([ListColumn.Modified]);
		expect(toggleListColumn(without, ListColumn.Kind)).toEqual([
			ListColumn.Modified,
			ListColumn.Kind,
		]);
	});

	it("guards wire values", () => {
		expect(isListColumn("modified")).toBe(true);
		expect(isListColumn("owner")).toBe(false);
	});
});

describe("listIconTrack", () => {
	it("reserves one shared track when ANY row in the folder has an icon", () => {
		// The regression: `grid-template-columns` is per-row, so an `auto`
		// leading track collapsed to 0 on iconless rows and reserved space on
		// icon-bearing ones — two column geometries in one list, with name,
		// kind and modified each landing at two different x positions.
		expect(listIconTrack(true, 18)).toBe("18px");
	});

	it("collapses the track when NOTHING in the folder has an icon", () => {
		// The no-default-type-icon-fallback rule survives: a uniformly iconless
		// folder still slides every name left into the slot.
		expect(listIconTrack(false, 18)).toBe("0px");
	});

	it("tracks the mode's icon size so density presets stay aligned", () => {
		expect(listIconTrack(true, 28)).toBe("28px");
	});
});
