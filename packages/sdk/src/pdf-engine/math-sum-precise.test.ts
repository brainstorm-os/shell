import { afterEach, describe, expect, it } from "vitest";
import { installMathSumPrecise, mathSumPrecise } from "./math-sum-precise";

describe("mathSumPrecise", () => {
	it("sums a plain list", () => {
		expect(mathSumPrecise([1, 2, 3])).toBe(6);
	});

	it("is precise where naive `+` cancels catastrophically", () => {
		// Naive left-to-right summation yields 0; the precise sum is 1.
		expect(mathSumPrecise([1e20, 1, -1e20])).toBe(1);
		expect([1e20, 1, -1e20].reduce((a, b) => a + b, 0)).toBe(0);
	});

	it("returns -0 for an empty iterable", () => {
		expect(Object.is(mathSumPrecise([]), -0)).toBe(true);
	});

	it("propagates NaN and infinities", () => {
		expect(Number.isNaN(mathSumPrecise([1, Number.NaN]))).toBe(true);
		expect(mathSumPrecise([1, Number.POSITIVE_INFINITY])).toBe(Number.POSITIVE_INFINITY);
		expect(Number.isNaN(mathSumPrecise([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]))).toBe(
			true,
		);
	});

	it("throws on a non-iterable argument", () => {
		expect(() => mathSumPrecise(42 as unknown as Iterable<number>)).toThrow(TypeError);
	});

	it("throws on a non-number element", () => {
		expect(() => mathSumPrecise([1, "2"] as unknown as Iterable<number>)).toThrow(TypeError);
	});

	it("closely tracks the native implementation when present (oracle)", () => {
		const native = (Math as { sumPrecise?: (v: Iterable<number>) => number }).sumPrecise;
		if (typeof native !== "function") return;
		// Compensated summation is accurate but not correctly-rounded like the
		// spec's exact algorithm, so compare within a tight relative tolerance
		// rather than bit-for-bit.
		for (const input of [
			[0.1, 0.2, 0.3],
			[1e20, 1, -1e20],
			[1.5, 2.5, 3.5, -0.25],
		]) {
			expect(mathSumPrecise(input)).toBeCloseTo(native(input), 10);
		}
	});
});

describe("installMathSumPrecise", () => {
	const original = Object.getOwnPropertyDescriptor(Math, "sumPrecise");

	afterEach(() => {
		if (original) Object.defineProperty(Math, "sumPrecise", original);
		else (Math as { sumPrecise?: unknown }).sumPrecise = undefined;
	});

	it("installs the polyfill onto Math when absent", () => {
		(Math as { sumPrecise?: unknown }).sumPrecise = undefined;
		installMathSumPrecise();
		const fn = (Math as { sumPrecise?: (v: Iterable<number>) => number }).sumPrecise;
		expect(typeof fn).toBe("function");
		expect(fn?.([1e20, 1, -1e20])).toBe(1);
	});

	it("does not overwrite a native implementation", () => {
		const sentinel = ((): number => 123) as unknown as (v: Iterable<number>) => number;
		Object.defineProperty(Math, "sumPrecise", {
			value: sentinel,
			configurable: true,
			writable: true,
		});
		installMathSumPrecise();
		expect((Math as { sumPrecise?: unknown }).sumPrecise).toBe(sentinel);
	});
});
