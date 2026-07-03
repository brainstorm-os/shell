import {
	ANTHROPIC_PROVIDER_ID,
	OLLAMA_PROVIDER_ID,
	OPENAI_PROVIDER_ID,
} from "@brainstorm/sdk-types";
import { describe, expect, it } from "vitest";
import { CREDIT_MICROS, FALLBACK_CLOUD_RATE, creditsMicroForUsage } from "./model-rates";

describe("creditsMicroForUsage", () => {
	it("local provider (ollama) is free", () => {
		expect(creditsMicroForUsage(OLLAMA_PROVIDER_ID, "llama3.2", 1_000_000, 1_000_000)).toBe(0);
	});

	it("prices a known model per MTok ($5/$25 opus)", () => {
		// 1M prompt + 1M completion at $5/$25 → 30 credits.
		expect(creditsMicroForUsage(ANTHROPIC_PROVIDER_ID, "claude-opus-4-8", 1_000_000, 1_000_000)).toBe(
			30 * CREDIT_MICROS,
		);
	});

	it("longest prefix wins (gpt-4o-mini vs gpt-4o)", () => {
		const mini = creditsMicroForUsage(OPENAI_PROVIDER_ID, "gpt-4o-mini", 1_000_000, 0);
		const full = creditsMicroForUsage(OPENAI_PROVIDER_ID, "gpt-4o-2024", 1_000_000, 0);
		expect(mini).toBe(0.15 * CREDIT_MICROS);
		expect(full).toBe(2.5 * CREDIT_MICROS);
	});

	it("unknown model falls back to the provider default", () => {
		expect(creditsMicroForUsage(ANTHROPIC_PROVIDER_ID, "claude-next-99", 1_000_000, 0)).toBe(
			3 * CREDIT_MICROS,
		);
	});

	it("unknown provider falls back to the conservative cloud rate (never free)", () => {
		expect(creditsMicroForUsage("mystery", "whatever", 1_000_000, 1_000_000)).toBe(
			FALLBACK_CLOUD_RATE.inputMicrosPerMTok + FALLBACK_CLOUD_RATE.outputMicrosPerMTok,
		);
	});

	it("rounds up per side — a tiny nonzero call is never free on a paid model", () => {
		// 1 prompt token on opus input ($5/MTok = 5 micro/token) → 5 micro-credits.
		expect(creditsMicroForUsage(ANTHROPIC_PROVIDER_ID, "claude-opus-4-8", 1, 0)).toBe(5);
		// 1 completion token at $25/MTok → 25 micro-credits.
		expect(creditsMicroForUsage(ANTHROPIC_PROVIDER_ID, "claude-opus-4-8", 0, 1)).toBe(25);
		// Fractional micro amounts ceil, so they can't round down to zero.
		expect(creditsMicroForUsage(OPENAI_PROVIDER_ID, "gpt-4.1-nano", 1, 0)).toBe(1);
	});

	it("negative token counts clamp to zero", () => {
		expect(creditsMicroForUsage(ANTHROPIC_PROVIDER_ID, "claude-opus-4-8", -50, -50)).toBe(0);
	});
});
