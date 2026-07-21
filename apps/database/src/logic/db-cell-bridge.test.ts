import type { PropertyDef } from "@brainstorm-os/sdk-types";
import { DateGranularity, ValueType } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { toCellValue, toDbValue } from "./db-cell-bridge";

const def = (over: Partial<PropertyDef> & { valueType: ValueType }): PropertyDef => ({
	key: "p",
	name: "P",
	icon: null,
	...over,
});

describe("db-cell-bridge", () => {
	it("dates: bare epoch-ms ↔ DateValue, stored back as a number", () => {
		const d = def({ valueType: ValueType.Date, granularity: DateGranularity.Date });
		const cell = toCellValue(d, 1_700_000_000_000) as { at: number; granularity: string };
		expect(cell.at).toBe(1_700_000_000_000);
		expect(cell.granularity).toBe(DateGranularity.Date);
		expect(toDbValue(d, cell)).toBe(1_700_000_000_000);
		expect(toCellValue(d, null)).toBeNull();
		expect(toDbValue(d, null)).toBeNull();
	});

	it("dates: tolerates an already-enveloped DateValue on read", () => {
		const d = def({ valueType: ValueType.Date });
		const stored = { at: 123, granularity: DateGranularity.DateTime };
		expect(toCellValue(d, stored)).toBe(stored);
	});

	it("multi-value: string[] ↔ LabeledValue[], stored back as string[]", () => {
		const d = def({
			valueType: ValueType.Text,
			vocabulary: { dictionaryId: "x" },
			count: { min: 0, max: 10 },
		});
		expect(toCellValue(d, ["a", "b"])).toEqual([{ value: "a" }, { value: "b" }]);
		expect(toDbValue(d, [{ value: "a" }, { value: "b" }])).toEqual(["a", "b"]);
		// Read tolerates an already-enveloped array; missing → [].
		expect(toCellValue(d, [{ value: "c" }])).toEqual([{ value: "c" }]);
		expect(toCellValue(d, null)).toEqual([]);
	});

	it("scalars: pass through with empty normalization", () => {
		const text = def({ valueType: ValueType.Text });
		expect(toCellValue(text, "hi")).toBe("hi");
		expect(toCellValue(text, "")).toBeNull();
		expect(toDbValue(text, "hi")).toBe("hi");
		expect(toDbValue(text, null)).toBeNull();

		const num = def({ valueType: ValueType.Number });
		expect(toCellValue(num, 42)).toBe(42);
		expect(toCellValue(num, "nope")).toBeNull();

		const bool = def({ valueType: ValueType.Boolean });
		expect(toCellValue(bool, true)).toBe(true);
		expect(toCellValue(bool, undefined)).toBe(false);
		expect(toDbValue(bool, true)).toBe(true);
		expect(toDbValue(bool, null)).toBe(false);
	});
});
