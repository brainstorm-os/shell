import { describe, expect, it } from "vitest";
import { MAX_FORMULA_LENGTH, compileFormula, evaluateFormula, formulaReferences } from "./index";

const resolver = (values: Record<string, unknown>) => (key: string) => values[key];

describe("compileFormula / evaluateFormula", () => {
	it("evaluates arithmetic over property references", () => {
		const r = evaluateFormula("{qty} * {rate}", resolver({ qty: 10, rate: 250 }));
		expect(r).toEqual({ ok: true, value: 2500 });
	});

	it("honours operator precedence and parentheses", () => {
		expect(evaluateFormula("2 + 3 * 4", resolver({}))).toEqual({ ok: true, value: 14 });
		expect(evaluateFormula("(2 + 3) * 4", resolver({}))).toEqual({ ok: true, value: 20 });
	});

	it("supports unary minus", () => {
		expect(evaluateFormula("-{x} + 5", resolver({ x: 3 }))).toEqual({ ok: true, value: 2 });
	});

	it("coerces numeric strings", () => {
		expect(evaluateFormula("{a} + {b}", resolver({ a: "1.5", b: 2 }))).toEqual({
			ok: true,
			value: 3.5,
		});
	});

	it("reports a non-numeric reference as a typed error (no throw)", () => {
		const r = evaluateFormula("{a} + 1", resolver({ a: "hello" }));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("{a}");
	});

	it("reports division by zero", () => {
		const r = evaluateFormula("{a} / 0", resolver({ a: 5 }));
		expect(r).toEqual({ ok: false, error: "Division by zero" });
	});

	it("rejects an empty expression at compile time", () => {
		expect(compileFormula("   ")).toEqual({ ok: false, error: "Empty formula" });
	});

	it("rejects a syntactically invalid expression", () => {
		const c = compileFormula("{a} * * {b}");
		expect(c.ok).toBe(false);
	});

	it("rejects an over-long expression (stack guard)", () => {
		const c = compileFormula(`${"1+".repeat(MAX_FORMULA_LENGTH)}1`);
		expect(c.ok).toBe(false);
	});

	it("compiles once and evaluates per row", () => {
		const c = compileFormula("{a} * 2");
		expect(c.ok).toBe(true);
		if (c.ok) {
			expect(c.formula.evaluate(resolver({ a: 3 }))).toEqual({ ok: true, value: 6 });
			expect(c.formula.evaluate(resolver({ a: 4 }))).toEqual({ ok: true, value: 8 });
			expect(c.formula.refs).toEqual(["a"]);
		}
	});
});

describe("formulaReferences", () => {
	it("returns distinct referenced keys", () => {
		expect(formulaReferences("{a} + {b} * {a}").sort()).toEqual(["a", "b"]);
	});

	it("tolerates a malformed expression (no refs)", () => {
		expect(formulaReferences("{unclosed")).toEqual([]);
	});
});
