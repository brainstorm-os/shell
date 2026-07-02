import { describe, expect, it } from "vitest";
import { columnValueSuggestions } from "./column-suggestions";
import type { EntityRow } from "./in-memory-entities";

const row = (properties: Record<string, unknown>): EntityRow => ({
	id: `e${Math.round(properties.__n as number) || 0}`,
	type: "T",
	properties,
	createdAt: 0,
	updatedAt: 0,
	deletedAt: null,
});

const rowsWith = (key: string, values: readonly unknown[]): EntityRow[] =>
	values.map((v, i) => row({ [key]: v, __n: i }));

describe("columnValueSuggestions", () => {
	it("ranks a repeated select column's distinct values by frequency then alpha", () => {
		const rows = rowsWith("status", ["Done", "To do", "Done", "Done", "To do", "Blocked"]);
		expect(columnValueSuggestions(rows, "status")).toEqual(["Done", "To do", "Blocked"]);
	});

	it("returns [] for an all-distinct column (an identifier / free text, not a select)", () => {
		const rows = rowsWith("name", ["Ada", "Bcd", "Cde", "Def"]);
		expect(columnValueSuggestions(rows, "name")).toEqual([]);
	});

	it("returns [] when any value is long prose (not a select label)", () => {
		const rows = rowsWith("excerpt", [
			"short",
			"short",
			"this is a long paragraph of prose that exceeds the select-label budget",
		]);
		expect(columnValueSuggestions(rows, "excerpt")).toEqual([]);
	});

	it("returns [] when there are too many distinct values to read as an enum", () => {
		const many = Array.from({ length: 30 }, (_, i) => `v${i}`);
		// duplicate the first so it's not all-distinct, but still > MAX_DISTINCT
		const rows = rowsWith("tag", [...many, "v0"]);
		expect(columnValueSuggestions(rows, "tag")).toEqual([]);
	});

	it("ignores empty / non-string values", () => {
		const rows = rowsWith("status", ["Open", "", null, "Open", 5, "Closed"]);
		expect(columnValueSuggestions(rows, "status")).toEqual(["Open", "Closed"]);
	});

	it("returns [] for an absent column", () => {
		const rows = rowsWith("status", ["Open", "Open"]);
		expect(columnValueSuggestions(rows, "missing")).toEqual([]);
	});
});
