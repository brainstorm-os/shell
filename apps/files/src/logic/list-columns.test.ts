import { describe, expect, it } from "vitest";
import {
	DEFAULT_LIST_COLUMNS,
	LIST_ACTIONS_TRACK,
	ListColumn,
	isListColumn,
	listIconTrack,
	listRowTemplate,
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

describe("list row template reserves a trailing actions track", () => {
	// The hover actions (export grip + ⋯) used to be overlays parked on top of
	// the LAST column, so "2 wks ago" lost its tail under the open icon. They
	// now own a track of their own, whatever the column chooser shows.
	it("ends in the actions track for every column set", () => {
		for (const columns of [
			[],
			[ListColumn.Kind],
			DEFAULT_LIST_COLUMNS,
			[ListColumn.Size, ListColumn.Modified, ListColumn.Kind],
		]) {
			const tracks = listRowTemplate("18px", columns).split(/\s+(?![^(]*\))/);
			expect(tracks[0]).toBe("18px");
			expect(tracks[1]).toBe("minmax(0, 1fr)");
			expect(tracks.at(-1)).toBe(LIST_ACTIONS_TRACK);
			expect(tracks).toHaveLength(columns.length + 3);
		}
	});
});
