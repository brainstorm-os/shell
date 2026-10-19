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
	it("reserves one fixed track so every row shares a column geometry", () => {
		// `grid-template-columns` is per-row: a track that varied with the row
		// (or collapsed to 0) put name, kind and modified at different x — and a
		// 0 track let the name land in the icon column as a sliver.
		expect(listIconTrack(18)).toBe("18px");
	});

	it("tracks the mode's icon size so density presets stay aligned", () => {
		expect(listIconTrack(28)).toBe("28px");
	});
});
