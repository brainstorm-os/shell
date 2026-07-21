import { ValueType } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { inferCsvColumns } from "./csv-infer";

describe("inferCsvColumns", () => {
	it("returns null for empty / whitespace-only input", () => {
		expect(inferCsvColumns("")).toBeNull();
		expect(inferCsvColumns("   \n  ")).toBeNull();
	});

	it("infers Text / Number / Boolean / Date per column", () => {
		const csv = [
			"Name,Age,Active,Joined",
			"Alice,30,true,2024-01-15",
			"Bob,25,false,2023-12-01",
			"Carol,42,yes,2024-06-30",
		].join("\n");
		const result = inferCsvColumns(csv);
		expect(result).not.toBeNull();
		if (!result) return;
		expect(result.columns.map((c) => [c.name, c.valueType])).toEqual([
			["Name", ValueType.Text],
			["Age", ValueType.Number],
			["Active", ValueType.Boolean],
			["Joined", ValueType.Date],
		]);
		expect(result.dataRows).toHaveLength(3);
	});

	it("treats a 0/1 column as Number, not Boolean", () => {
		const result = inferCsvColumns(["Flag", "0", "1", "0"].join("\n"));
		expect(result?.columns[0]?.valueType).toBe(ValueType.Number);
	});

	it("does not mistake a dashed date for a number", () => {
		const result = inferCsvColumns(["When", "2024-01-15", "2024-02-20"].join("\n"));
		expect(result?.columns[0]?.valueType).toBe(ValueType.Date);
	});

	it("a mixed column falls back to Text", () => {
		const result = inferCsvColumns(["Mix", "10", "hello", "true"].join("\n"));
		expect(result?.columns[0]?.valueType).toBe(ValueType.Text);
	});

	it("an all-empty column is Text", () => {
		const result = inferCsvColumns(["A,B", "x,", "y,"].join("\n"));
		expect(result?.columns[1]?.valueType).toBe(ValueType.Text);
	});

	it("names a blank header cell Column N (1-based)", () => {
		const result = inferCsvColumns(["First,,Third", "a,b,c"].join("\n"));
		expect(result?.columns.map((c) => c.name)).toEqual(["First", "Column 2", "Third"]);
	});

	it("tolerates short rows (missing trailing cells treated as empty)", () => {
		// Second data row is missing the Age cell — must not throw, and the
		// present numeric values still infer Number.
		const result = inferCsvColumns(["Name,Age", "Alice,30", "Bob"].join("\n"));
		expect(result?.columns[1]?.valueType).toBe(ValueType.Number);
		expect(result?.dataRows).toHaveLength(2);
	});

	it("infers from a header with no data rows as Text", () => {
		const result = inferCsvColumns("Name,Age");
		expect(result?.columns.map((c) => c.valueType)).toEqual([ValueType.Text, ValueType.Text]);
		expect(result?.dataRows).toHaveLength(0);
	});
});
