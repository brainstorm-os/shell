/**
 * Validator tests for the composable property model. Each test focuses
 * on one validator path; the matrix is "shape × valueType × modifier".
 */

import {
	DateGranularity,
	FILE_ENTITY_TYPE,
	type LabeledValue,
	type PropertyDef,
	PropertyFormat,
	ValueType,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	coerceValue,
	emptyValueFor,
	isEmptyValue,
	validateDictionary,
	validateDictionaryItem,
	validatePropertyDef,
	validateValue,
} from "./properties-validate";

const BASE = { key: "prop_test", name: "Test", icon: null } as const;

function makeDef<V extends ValueType>(
	valueType: V,
	overrides: Partial<PropertyDef> = {},
): PropertyDef & { valueType: V } {
	return { ...BASE, valueType, ...overrides } as PropertyDef & { valueType: V };
}

describe("validatePropertyDef — base shape", () => {
	it("accepts a minimal text def", () => {
		expect(validatePropertyDef(makeDef(ValueType.Text))).toEqual({ ok: true });
	});

	it("rejects an empty name", () => {
		const result = validatePropertyDef(makeDef(ValueType.Text, { name: "   " }));
		expect(result.ok).toBe(false);
	});

	it("rejects an empty key", () => {
		const result = validatePropertyDef(makeDef(ValueType.Text, { key: "" }));
		expect(result.ok).toBe(false);
	});

	it("rejects an unknown valueType", () => {
		// biome-ignore lint/suspicious/noExplicitAny: tests an invalid runtime value
		const result = validatePropertyDef({ ...BASE, valueType: "bogus" as any });
		expect(result.ok).toBe(false);
	});
});

describe("validatePropertyDef — cardinality", () => {
	it("accepts the default-omitted cardinality", () => {
		expect(validatePropertyDef(makeDef(ValueType.Text)).ok).toBe(true);
	});

	it("rejects min > max", () => {
		expect(validatePropertyDef(makeDef(ValueType.Text, { count: { min: 5, max: 1 } })).ok).toBe(
			false,
		);
	});

	it("rejects max < 1", () => {
		expect(validatePropertyDef(makeDef(ValueType.Text, { count: { min: 0, max: 0 } })).ok).toBe(
			false,
		);
	});

	it("rejects max > 50 (hard cap)", () => {
		expect(validatePropertyDef(makeDef(ValueType.Text, { count: { min: 0, max: 51 } })).ok).toBe(
			false,
		);
	});

	it("rejects negative min", () => {
		expect(validatePropertyDef(makeDef(ValueType.Text, { count: { min: -1, max: 5 } })).ok).toBe(
			false,
		);
	});

	it("requires count {1,1} on richText when set", () => {
		expect(validatePropertyDef(makeDef(ValueType.RichText, { count: { min: 0, max: 1 } })).ok).toBe(
			false,
		);
		expect(validatePropertyDef(makeDef(ValueType.RichText, { count: { min: 1, max: 1 } })).ok).toBe(
			true,
		);
	});
});

describe("validatePropertyDef — format", () => {
	it("accepts url / email / phone / markdown / code on text", () => {
		for (const f of [
			PropertyFormat.Url,
			PropertyFormat.Email,
			PropertyFormat.Phone,
			PropertyFormat.Markdown,
			PropertyFormat.Code,
		]) {
			expect(validatePropertyDef(makeDef(ValueType.Text, { format: f })).ok).toBe(true);
		}
	});

	it("accepts currency / percent / duration on number", () => {
		expect(
			validatePropertyDef(makeDef(ValueType.Number, { format: PropertyFormat.Currency })).ok,
		).toBe(true);
		expect(
			validatePropertyDef(makeDef(ValueType.Number, { format: PropertyFormat.Percent })).ok,
		).toBe(true);
		expect(
			validatePropertyDef(makeDef(ValueType.Number, { format: PropertyFormat.Duration })).ok,
		).toBe(true);
	});

	it("rejects duration on text", () => {
		expect(validatePropertyDef(makeDef(ValueType.Text, { format: PropertyFormat.Duration })).ok).toBe(
			false,
		);
	});

	it("rejects currency on text", () => {
		expect(validatePropertyDef(makeDef(ValueType.Text, { format: PropertyFormat.Currency })).ok).toBe(
			false,
		);
	});

	it("rejects format on boolean / date / entityRef / richText", () => {
		for (const vt of [ValueType.Boolean, ValueType.Date, ValueType.EntityRef, ValueType.RichText]) {
			expect(validatePropertyDef(makeDef(vt, { format: PropertyFormat.Url })).ok).toBe(false);
		}
	});
});

describe("validatePropertyDef — vocabulary", () => {
	it("accepts vocabulary on text", () => {
		expect(
			validatePropertyDef(makeDef(ValueType.Text, { vocabulary: { dictionaryId: "d1" } })).ok,
		).toBe(true);
	});

	it("accepts vocabulary on number", () => {
		expect(
			validatePropertyDef(makeDef(ValueType.Number, { vocabulary: { dictionaryId: "d1" } })).ok,
		).toBe(true);
	});

	it("rejects vocabulary on boolean / date / entityRef / richText", () => {
		for (const vt of [ValueType.Boolean, ValueType.Date, ValueType.EntityRef, ValueType.RichText]) {
			expect(validatePropertyDef(makeDef(vt, { vocabulary: { dictionaryId: "d1" } })).ok).toBe(false);
		}
	});

	it("rejects vocabulary without dictionaryId", () => {
		expect(
			validatePropertyDef(makeDef(ValueType.Text, { vocabulary: { dictionaryId: "" } })).ok,
		).toBe(false);
	});
});

describe("validatePropertyDef — entityRef modifiers", () => {
	it("accepts allowedTypes on entityRef", () => {
		expect(
			validatePropertyDef(makeDef(ValueType.EntityRef, { allowedTypes: ["io.example/Person/v1"] })).ok,
		).toBe(true);
	});

	it("rejects allowedTypes on text", () => {
		expect(validatePropertyDef(makeDef(ValueType.Text, { allowedTypes: ["x"] })).ok).toBe(false);
	});

	it("rejects entityFilter on non-entityRef", () => {
		expect(
			validatePropertyDef(makeDef(ValueType.Text, { entityFilter: { mimeType: "image/*" } })).ok,
		).toBe(false);
	});

	it("accepts the File-preset shape (entityRef + allowedTypes=File)", () => {
		expect(
			validatePropertyDef(
				makeDef(ValueType.EntityRef, {
					allowedTypes: [FILE_ENTITY_TYPE],
					count: { min: 0, max: 50 },
				}),
			).ok,
		).toBe(true);
	});
});

describe("validatePropertyDef — number-only modifiers", () => {
	it("range valid on number / date only", () => {
		expect(validatePropertyDef(makeDef(ValueType.Number, { range: { min: 0, max: 10 } })).ok).toBe(
			true,
		);
		expect(validatePropertyDef(makeDef(ValueType.Date, { range: { min: 0, max: 100 } })).ok).toBe(
			true,
		);
		expect(validatePropertyDef(makeDef(ValueType.Text, { range: { min: 0, max: 10 } })).ok).toBe(
			false,
		);
	});

	it("rejects range.min > range.max", () => {
		expect(validatePropertyDef(makeDef(ValueType.Number, { range: { min: 10, max: 0 } })).ok).toBe(
			false,
		);
	});

	it("precision only valid on number, must be non-negative integer", () => {
		expect(validatePropertyDef(makeDef(ValueType.Number, { precision: 2 })).ok).toBe(true);
		expect(validatePropertyDef(makeDef(ValueType.Number, { precision: -1 })).ok).toBe(false);
		expect(validatePropertyDef(makeDef(ValueType.Text, { precision: 2 })).ok).toBe(false);
	});

	it("currency only valid when number + format=currency", () => {
		expect(
			validatePropertyDef(
				makeDef(ValueType.Number, { format: PropertyFormat.Currency, currency: "USD" }),
			).ok,
		).toBe(true);
		expect(validatePropertyDef(makeDef(ValueType.Number, { currency: "USD" })).ok).toBe(false);
		expect(
			validatePropertyDef(
				makeDef(ValueType.Text, { format: PropertyFormat.Markdown, currency: "USD" }),
			).ok,
		).toBe(false);
	});
});

describe("validatePropertyDef — granularity", () => {
	it("granularity only valid on date", () => {
		expect(
			validatePropertyDef(makeDef(ValueType.Date, { granularity: DateGranularity.DateTime })).ok,
		).toBe(true);
		expect(
			validatePropertyDef(makeDef(ValueType.Text, { granularity: DateGranularity.DateTime })).ok,
		).toBe(false);
	});
});

describe("validatePropertyDef — pattern", () => {
	it("pattern only valid on text", () => {
		expect(validatePropertyDef(makeDef(ValueType.Text, { pattern: "^abc.*$" })).ok).toBe(true);
		expect(validatePropertyDef(makeDef(ValueType.Number, { pattern: "^abc.*$" })).ok).toBe(false);
	});
});

describe("validateValue — scalar shapes (count.max = 1)", () => {
	it("text accepts string | null", () => {
		const def = makeDef(ValueType.Text);
		expect(validateValue(def, "hi").ok).toBe(true);
		expect(validateValue(def, null).ok).toBe(true);
		expect(validateValue(def, 42).ok).toBe(false);
	});

	it("number accepts finite number | null", () => {
		const def = makeDef(ValueType.Number);
		expect(validateValue(def, 0).ok).toBe(true);
		expect(validateValue(def, null).ok).toBe(true);
		expect(validateValue(def, Number.NaN).ok).toBe(false);
	});

	it("boolean accepts true / false only", () => {
		const def = makeDef(ValueType.Boolean);
		expect(validateValue(def, true).ok).toBe(true);
		expect(validateValue(def, false).ok).toBe(true);
		expect(validateValue(def, null).ok).toBe(false);
	});

	it("date accepts { at, granularity } or null", () => {
		const def = makeDef(ValueType.Date);
		expect(validateValue(def, null).ok).toBe(true);
		expect(validateValue(def, { at: 1, granularity: DateGranularity.Date }).ok).toBe(true);
		expect(validateValue(def, { at: 1 }).ok).toBe(false);
	});

	it("entityRef accepts string id or null", () => {
		const def = makeDef(ValueType.EntityRef);
		expect(validateValue(def, "ent_abc").ok).toBe(true);
		expect(validateValue(def, null).ok).toBe(true);
		expect(validateValue(def, 42).ok).toBe(false);
	});
});

describe("validateValue — multi shapes (count.max > 1)", () => {
	it("requires an array envelope", () => {
		const def = makeDef(ValueType.Text, { count: { min: 0, max: 5 } });
		expect(validateValue(def, "x").ok).toBe(false);
		expect(validateValue(def, []).ok).toBe(true);
	});

	it("requires each entry to be { value, label? }", () => {
		const def = makeDef(ValueType.Text, { count: { min: 0, max: 5 } });
		expect(validateValue(def, [{ value: "a" }, { value: "b", label: "Work" }]).ok).toBe(true);
		expect(validateValue(def, ["a", "b"]).ok).toBe(false);
		expect(validateValue(def, [{ value: 1 }]).ok).toBe(false);
	});

	it("entityRef multi keeps the LabeledValue envelope", () => {
		const def = makeDef(ValueType.EntityRef, { count: { min: 0, max: 50 } });
		expect(validateValue(def, [{ value: "ent_a" }, { value: "ent_b", label: "Manager" }]).ok).toBe(
			true,
		);
	});
});

describe("coerceValue — tolerance", () => {
	it("scalar coerce → kind-empty on type mismatch", () => {
		const def = makeDef(ValueType.Number);
		expect(coerceValue(def, "not a number")).toBe(null);
	});

	it("number coerce clamps to range", () => {
		const def = makeDef(ValueType.Number, { range: { min: 0, max: 10 } });
		expect(coerceValue(def, -5)).toBe(0);
		expect(coerceValue(def, 100)).toBe(10);
		expect(coerceValue(def, 5)).toBe(5);
	});

	it("multi coerce drops malformed entries", () => {
		const def = makeDef(ValueType.Text, { count: { min: 0, max: 5 } });
		const raw = [{ value: "ok" }, "loose-string", { other: "x" }, null];
		const out = coerceValue(def, raw) as readonly LabeledValue<string>[];
		expect(out.length).toBe(2);
		const [first, second] = out;
		expect(first?.value).toBe("ok");
		expect(second?.value).toBe("loose-string");
	});
});

describe("emptyValueFor + isEmptyValue", () => {
	it("scalar text → null", () => {
		const def = makeDef(ValueType.Text);
		expect(emptyValueFor(def)).toBeNull();
		expect(isEmptyValue(def, null)).toBe(true);
		expect(isEmptyValue(def, "hi")).toBe(false);
	});

	it("scalar boolean → false", () => {
		const def = makeDef(ValueType.Boolean);
		expect(emptyValueFor(def)).toBe(false);
		expect(isEmptyValue(def, false)).toBe(true);
		expect(isEmptyValue(def, true)).toBe(false);
	});

	it("multi text → []", () => {
		const def = makeDef(ValueType.Text, { count: { min: 0, max: 5 } });
		expect(emptyValueFor(def)).toEqual([]);
		expect(isEmptyValue(def, [])).toBe(true);
		expect(isEmptyValue(def, [{ value: "x" }])).toBe(false);
	});
});

describe("Dictionary validators", () => {
	it("accepts a well-formed dictionary", () => {
		const result = validateDictionary({
			id: "d1",
			name: "Status",
			items: [
				{ id: "i1", label: "Todo", icon: null, sortIndex: 0 },
				{ id: "i2", label: "Done", icon: null, sortIndex: 1, colour: "#00ff00" },
			],
		});
		expect(result).toEqual({ ok: true });
	});

	it("rejects duplicate item ids", () => {
		const result = validateDictionary({
			id: "d1",
			name: "Status",
			items: [
				{ id: "i1", label: "A", icon: null, sortIndex: 0 },
				{ id: "i1", label: "A again", icon: null, sortIndex: 1 },
			],
		});
		expect(result.ok).toBe(false);
	});

	it("rejects malformed colour", () => {
		const result = validateDictionaryItem({
			id: "i1",
			label: "A",
			icon: null,
			sortIndex: 0,
			colour: "red",
		});
		expect(result.ok).toBe(false);
	});

	it("rejects non-finite sortIndex", () => {
		const result = validateDictionaryItem({
			id: "i1",
			label: "A",
			icon: null,
			sortIndex: Number.NaN,
		});
		expect(result.ok).toBe(false);
	});
});
