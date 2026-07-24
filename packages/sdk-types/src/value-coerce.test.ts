import { describe, expect, it } from "vitest";
import { ValueType } from "./properties";
import { coerceScalarValue } from "./value-coerce";

describe("coerceScalarValue", () => {
	it("returns undefined for blank / missing input of any type", () => {
		for (const type of [ValueType.Text, ValueType.Number, ValueType.Boolean, ValueType.Date]) {
			expect(coerceScalarValue("   ", type)).toBeUndefined();
			expect(coerceScalarValue(undefined, type)).toBeUndefined();
		}
	});

	it("trims text", () => {
		expect(coerceScalarValue("  hello ", ValueType.Text)).toBe("hello");
	});

	it("parses finite numbers and drops unparseable ones", () => {
		expect(coerceScalarValue("1200", ValueType.Number)).toBe(1200);
		expect(coerceScalarValue("-3.5", ValueType.Number)).toBe(-3.5);
		expect(coerceScalarValue("twelve", ValueType.Number)).toBeUndefined();
		expect(coerceScalarValue("Infinity", ValueType.Number)).toBeUndefined();
	});

	it("parses the common boolean spellings, case-insensitively", () => {
		expect(coerceScalarValue("true", ValueType.Boolean)).toBe(true);
		expect(coerceScalarValue("YES", ValueType.Boolean)).toBe(true);
		expect(coerceScalarValue("false", ValueType.Boolean)).toBe(false);
		expect(coerceScalarValue("No", ValueType.Boolean)).toBe(false);
		expect(coerceScalarValue("maybe", ValueType.Boolean)).toBeUndefined();
	});

	it("parses dates to Unix-ms and drops unparseable ones", () => {
		expect(coerceScalarValue("2026-03-04T00:00:00.000Z", ValueType.Date)).toBe(
			Date.parse("2026-03-04T00:00:00.000Z"),
		);
		expect(coerceScalarValue("next tuesday", ValueType.Date)).toBeUndefined();
	});

	it("falls back to trimmed text for the non-scalar value types", () => {
		expect(coerceScalarValue(" ent_1 ", ValueType.EntityRef)).toBe("ent_1");
		expect(coerceScalarValue(" body ", ValueType.RichText)).toBe("body");
	});
});
