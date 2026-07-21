import type { Dictionary, DictionaryItem } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	DictionarySortMode,
	activeItems,
	archivedItems,
	chipColours,
	dictionarySortPrefKey,
	filterItems,
	findItem,
	isArchived,
	nextSortIndex,
	parseDictionarySortMode,
	sortItems,
} from "./dictionary-helpers";

const item = (
	id: string,
	label: string,
	sortIndex: number,
	over: Partial<DictionaryItem> = {},
): DictionaryItem => ({ id, label, icon: null, sortIndex, ...over });

const dict = (items: DictionaryItem[]): Dictionary => ({ id: "dict_a", name: "Status", items });

describe("dictionary-helpers", () => {
	it("partitions active vs archived items", () => {
		const d = dict([item("a", "A", 0), item("b", "B", 1, { archivedAt: 123 }), item("c", "C", 2)]);
		expect(activeItems(d).map((i) => i.id)).toEqual(["a", "c"]);
		expect(archivedItems(d).map((i) => i.id)).toEqual(["b"]);
		expect(isArchived(item("b", "B", 1, { archivedAt: 1 }))).toBe(true);
		expect(isArchived(item("a", "A", 0))).toBe(false);
		expect(activeItems(undefined)).toEqual([]);
	});

	it("findItem resolves by id, tolerating null/missing", () => {
		const d = dict([item("a", "A", 0)]);
		expect(findItem(d, "a")?.label).toBe("A");
		expect(findItem(d, "z")).toBeUndefined();
		expect(findItem(d, null)).toBeUndefined();
		expect(findItem(undefined, "a")).toBeUndefined();
	});

	it("sorts by mode (manual / alpha / alpha-desc / most-used)", () => {
		const items = [item("a", "Beta", 2), item("b", "alpha", 0), item("c", "Gamma", 1)];
		expect(sortItems(items, DictionarySortMode.Manual).map((i) => i.id)).toEqual(["b", "c", "a"]);
		expect(sortItems(items, DictionarySortMode.Alpha).map((i) => i.label)).toEqual([
			"alpha",
			"Beta",
			"Gamma",
		]);
		expect(sortItems(items, DictionarySortMode.AlphaDesc).map((i) => i.label)).toEqual([
			"Gamma",
			"Beta",
			"alpha",
		]);
		const usage = new Map([
			["a", 1],
			["b", 9],
			["c", 4],
		]);
		expect(sortItems(items, DictionarySortMode.MostUsed, usage).map((i) => i.id)).toEqual([
			"b",
			"c",
			"a",
		]);
	});

	it("filters items by case-insensitive label substring", () => {
		const items = [item("a", "Done", 0), item("b", "In Progress", 1), item("c", "Blocked", 2)];
		expect(filterItems(items, "pro").map((i) => i.id)).toEqual(["b"]);
		expect(filterItems(items, "  ").map((i) => i.id)).toEqual(["a", "b", "c"]);
		expect(filterItems(items, "ZZZ")).toEqual([]);
	});

	it("derives chip colours from the item's own accent, neutral otherwise", () => {
		const withColour = chipColours("#ff0066");
		expect(withColour.background).toContain("#ff0066");
		expect(withColour.foreground).toContain("#ff0066");
		const neutral = chipColours(undefined);
		expect(neutral.background).toBe("var(--bg-elev)");
		expect(chipColours(item("a", "A", 0, { colour: "#112233" })).border).toContain("#112233");
	});

	it("re-validates the accent against the hex pattern (no color-mix injection)", () => {
		// Valid 6-digit hex → mixed; case + surrounding whitespace tolerated.
		expect(chipColours("#ABCDEF").background).toContain("#ABCDEF");
		expect(chipColours("  #abcdef  ").foreground).toContain("#abcdef");
		// Anything not a strict hex falls through to the neutral branch so
		// nothing untrusted reaches `color-mix(...)`.
		for (const bad of [
			"red",
			"#fff",
			"#1234567",
			"url(https://x)",
			"rgb(0,0,0)",
			"var(--x); }",
			"",
		]) {
			const c = chipColours(bad);
			expect(c.background).toBe("var(--bg-elev)");
			expect(c.foreground).toBe("var(--text)");
			expect(c.border).toBe("var(--border)");
		}
	});

	it("parses + builds the per-user sort pref", () => {
		expect(dictionarySortPrefKey("dict_x")).toBe("app.settings:dictionary-sort:dict_x");
		expect(parseDictionarySortMode("alpha")).toBe(DictionarySortMode.Alpha);
		expect(parseDictionarySortMode("garbage")).toBe(DictionarySortMode.Manual);
		expect(parseDictionarySortMode(undefined)).toBe(DictionarySortMode.Manual);
	});

	it("nextSortIndex returns max+1, 0 for an empty dictionary", () => {
		expect(nextSortIndex(dict([]))).toBe(0);
		expect(nextSortIndex(dict([item("a", "A", 3), item("b", "B", 7)]))).toBe(8);
		expect(nextSortIndex(undefined)).toBe(0);
	});
});
