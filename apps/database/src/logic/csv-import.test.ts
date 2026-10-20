import {
	DateGranularity,
	GENERIC_OBJECT_TYPE,
	type PropertyDef,
	ValueType,
} from "@brainstorm-os/sdk-types";
import { formatScalar } from "@brainstorm-os/sdk/property-ui/pure";
import { describe, expect, it, vi } from "vitest";
import { commitCsvImport, csvToEntityImport, propertyDefsForCsvImport } from "./csv-import";

const CSV = ["Name,Age,Active,Joined", "Alice,30,true,2024-01-15", "Bob,25,no,2023-12-01"].join(
	"\n",
);

describe("csvToEntityImport", () => {
	it("returns null for empty input", () => {
		expect(csvToEntityImport("")).toBeNull();
	});

	it("uses the first column as the title and the rest as typed properties", () => {
		const imported = csvToEntityImport(CSV);
		expect(imported).not.toBeNull();
		if (!imported) return;
		expect(imported.nameColumn.name).toBe("Name");
		expect(imported.propertyColumns.map((c) => c.name)).toEqual(["Age", "Active", "Joined"]);
		expect(imported.rows).toEqual([
			{ name: "Alice", Age: 30, Active: true, Joined: Date.parse("2024-01-15") },
			{ name: "Bob", Age: 25, Active: false, Joined: Date.parse("2023-12-01") },
		]);
	});

	it("coerces to the inferred type and omits blank cells", () => {
		const imported = csvToEntityImport("Title,Score\nA,\nB,7");
		if (!imported) return;
		// A's blank Score is omitted entirely (an empty cell, not a 0).
		expect(imported.rows[0]).toEqual({ name: "A" });
		expect(imported.rows[1]).toEqual({ name: "B", Score: 7 });
	});

	it("commits a Date column as a Unix-ms timestamp (renders as a date, not text)", () => {
		const imported = must(csvToEntityImport(CSV));
		const joined = imported.rows[0]?.Joined;
		expect(typeof joined).toBe("number");
		expect(joined).toBe(Date.parse("2024-01-15"));
	});
});

describe("commitCsvImport", () => {
	it("creates one generic Object per row and returns their ids", async () => {
		const imported = must(csvToEntityImport(CSV));
		let n = 0;
		const create = vi.fn(async (_type: string, _props: Record<string, unknown>) => ({
			id: `ent_${++n}`,
		}));
		const ids = await commitCsvImport(imported, { create });
		expect(ids).toEqual(["ent_1", "ent_2"]);
		expect(create).toHaveBeenCalledTimes(2);
		expect(create).toHaveBeenNthCalledWith(1, GENERIC_OBJECT_TYPE, {
			name: "Alice",
			Age: 30,
			Active: true,
			Joined: Date.parse("2024-01-15"),
		});
	});

	it("skips a row whose create returns no id (partial import beats aborting)", async () => {
		const imported = must(csvToEntityImport(CSV));
		const create = vi.fn().mockResolvedValueOnce({ id: "" }).mockResolvedValueOnce({ id: "ent_2" });
		const ids = await commitCsvImport(imported, { create });
		expect(ids).toEqual(["ent_2"]);
	});
});

function must<T>(value: T | null | undefined): T {
	if (value === null || value === undefined) throw new Error("expected a value");
	return value;
}

describe("propertyDefsForCsvImport (F-511a)", () => {
	it("registers one catalog def per property column, keyed by the header and typed as inferred", () => {
		const defs = propertyDefsForCsvImport(must(csvToEntityImport(CSV)), []);
		expect(defs.map((d) => [d.key, d.name, d.valueType])).toEqual([
			["Age", "Age", ValueType.Number],
			["Active", "Active", ValueType.Boolean],
			["Joined", "Joined", ValueType.Date],
		]);
		expect(defs.find((d) => d.key === "Joined")?.granularity).toBe(DateGranularity.Date);
	});

	it("never registers the title column", () => {
		const defs = propertyDefsForCsvImport(must(csvToEntityImport(CSV)), []);
		expect(defs.some((d) => d.key === "Name" || d.key === "name")).toBe(false);
	});

	it("leaves a key the catalog already holds alone", () => {
		const existing: PropertyDef = { key: "Age", name: "Age", icon: null, valueType: ValueType.Text };
		const defs = propertyDefsForCsvImport(must(csvToEntityImport(CSV)), [existing]);
		expect(defs.map((d) => d.key)).toEqual(["Active", "Joined"]);
	});

	it("a registered Number column takes a unit like any catalog property (F-511b)", () => {
		const age = propertyDefsForCsvImport(must(csvToEntityImport(CSV)), []).find(
			(d) => d.key === "Age",
		);
		expect(age).toBeDefined();
		expect(formatScalar({ ...(age as PropertyDef), unit: "people" }, 3)).toBe("3 people");
	});
});
