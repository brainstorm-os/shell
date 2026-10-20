import { type PropertyDef, PropertyFormat, ValueType } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	ConversionOutcome,
	canChangeType,
	convertValue,
	defForType,
	planTypeChange,
	typeChangePatches,
} from "./change-type";
import type { EntityRow } from "./in-memory-entities";

const row = (id: string, properties: Record<string, unknown>): EntityRow => ({
	id,
	type: "t",
	properties,
	createdAt: 0,
	updatedAt: 0,
	deletedAt: null,
});

const TEXT: PropertyDef = { key: "size", name: "Size", icon: null, valueType: ValueType.Text };

describe("convertValue (9.12.33)", () => {
	it("converts across scalar types and reports what can't be represented", () => {
		expect(convertValue("42", ValueType.Text, ValueType.Number)).toBe(42);
		expect(convertValue("big", ValueType.Text, ValueType.Number)).toBeUndefined();
		expect(convertValue(3, ValueType.Number, ValueType.Text)).toBe("3");
		expect(convertValue(true, ValueType.Boolean, ValueType.Number)).toBe(1);
		expect(convertValue(1, ValueType.Number, ValueType.Boolean)).toBe(true);
		expect(convertValue(7, ValueType.Number, ValueType.Boolean)).toBeUndefined();
		expect(convertValue("yes", ValueType.Text, ValueType.Boolean)).toBe(true);
		expect(convertValue(Date.UTC(2026, 0, 5), ValueType.Date, ValueType.Text)).toBe("2026-01-05");
		expect(convertValue("2026-01-05", ValueType.Text, ValueType.Date)).toBe(Date.parse("2026-01-05"));
		expect(convertValue(5, ValueType.Number, ValueType.Date)).toBeUndefined();
		expect(convertValue("", ValueType.Text, ValueType.Number)).toBeNull();
	});
});

describe("planTypeChange", () => {
	const rows = [
		row("a", { size: "12" }),
		row("b", { size: "large" }),
		row("c", { size: "9", locked: true }),
		row("d", {}),
	];

	it("previews per-row conversion, lost rows and locked rows; skips empties", () => {
		const plan = planTypeChange(rows, TEXT, ValueType.Number);
		expect(plan.rows.map((r) => [r.id, r.outcome, r.after])).toEqual([
			["a", ConversionOutcome.Converted, 12],
			["b", ConversionOutcome.Lost, null],
			["c", ConversionOutcome.Locked, "9"],
		]);
		expect([plan.converted, plan.lost, plan.locked]).toEqual([1, 1, 1]);
		expect(plan.nextDef.valueType).toBe(ValueType.Number);
		expect(typeChangePatches(plan)).toEqual([
			{ id: "a", patch: { size: 12 } },
			{ id: "b", patch: { size: null } },
		]);
	});

	it("drops modifiers the new type can't carry", () => {
		const money: PropertyDef = {
			key: "fee",
			name: "Fee",
			icon: null,
			valueType: ValueType.Number,
			format: PropertyFormat.Currency,
			currency: "EUR",
			precision: 2,
		};
		expect(defForType(money, ValueType.Text)).toEqual({
			key: "fee",
			name: "Fee",
			icon: null,
			valueType: ValueType.Text,
		});
	});

	it("only offers scalar, single-valued, non-select properties", () => {
		expect(canChangeType(TEXT)).toBe(true);
		expect(canChangeType({ ...TEXT, vocabulary: { dictionaryId: "d" } })).toBe(false);
		expect(canChangeType({ ...TEXT, valueType: ValueType.EntityRef })).toBe(false);
		expect(canChangeType(null)).toBe(false);
	});
});
