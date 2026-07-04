import { describe, expect, it } from "vitest";
import { budgetConsumedFraction, formatCredits, isBudgetExhausted } from "./ai-budget-view";

describe("formatCredits", () => {
	it("renders two decimals under 100 credits, rounding up", () => {
		expect(formatCredits(0)).toBe("0.00");
		expect(formatCredits(1)).toBe("0.01"); // 1 micro never displays as free
		expect(formatCredits(1_500_000)).toBe("1.50");
		expect(formatCredits(99_994_000)).toBe("100.00");
	});

	it("renders whole credits from 100 up", () => {
		expect(formatCredits(100_000_000)).toBe("100");
		expect(formatCredits(12_345_000_000)).toBe("12345");
	});
});

describe("isBudgetExhausted", () => {
	it("false without usage or budget", () => {
		expect(isBudgetExhausted(undefined, { maxTokens: 10 })).toBe(false);
		expect(isBudgetExhausted({ totalTokens: 99, creditsMicro: 0 }, undefined)).toBe(false);
	});

	it("mirrors the broker comparison (>= on either unit)", () => {
		expect(isBudgetExhausted({ totalTokens: 10, creditsMicro: 0 }, { maxTokens: 10 })).toBe(true);
		expect(isBudgetExhausted({ totalTokens: 9, creditsMicro: 0 }, { maxTokens: 10 })).toBe(false);
		expect(isBudgetExhausted({ totalTokens: 0, creditsMicro: 5_000_000 }, { maxCredits: 5 })).toBe(
			true,
		);
		expect(isBudgetExhausted({ totalTokens: 0, creditsMicro: 4_999_999 }, { maxCredits: 5 })).toBe(
			false,
		);
	});

	it("either exhausted unit trips it", () => {
		expect(
			isBudgetExhausted(
				{ totalTokens: 1, creditsMicro: 9_000_000 },
				{ maxTokens: 1000, maxCredits: 9 },
			),
		).toBe(true);
	});
});

describe("budgetConsumedFraction", () => {
	it("null when unbudgeted", () => {
		expect(budgetConsumedFraction({ totalTokens: 5, creditsMicro: 5 }, undefined)).toBeNull();
		expect(budgetConsumedFraction({ totalTokens: 5, creditsMicro: 5 }, {})).toBeNull();
	});

	it("uses the tightest ceiling and caps at 1", () => {
		expect(budgetConsumedFraction({ totalTokens: 50, creditsMicro: 0 }, { maxTokens: 100 })).toBe(
			0.5,
		);
		expect(
			budgetConsumedFraction(
				{ totalTokens: 10, creditsMicro: 9_000_000 },
				{ maxTokens: 100, maxCredits: 10 },
			),
		).toBe(0.9);
		expect(budgetConsumedFraction({ totalTokens: 500, creditsMicro: 0 }, { maxTokens: 100 })).toBe(1);
	});

	it("zero usage reads as zero consumed", () => {
		expect(budgetConsumedFraction(undefined, { maxTokens: 100 })).toBe(0);
	});
});
