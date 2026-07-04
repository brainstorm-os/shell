/**
 * 14.8 — the static per-model credit rate table.
 *
 * Credits are the product's AI accounting unit: **1 credit = 1 USD of
 * provider list price**, stored as integer micro-credits (1 credit =
 * 1,000,000 micro) so SQL sums never accumulate float drift. Rates are
 * expressed as micro-credits per **million** tokens — numerically equal to
 * the provider's advertised dollars-per-MTok — which keeps this table a
 * transcription job, not a conversion job: to update a price, paste the
 * provider's $/MTok numbers.
 *
 * Matching is longest-prefix on the model id within the provider's entry
 * list, falling back to the provider's `defaultRate`, falling back to
 * `FALLBACK_CLOUD_RATE` for an unknown cloud provider. Local providers
 * (Ollama) cost 0 by construction. Prices drift; this table is deliberately
 * boring so updating it is a one-line diff per model.
 */

import {
	ANTHROPIC_PROVIDER_ID,
	GEMINI_PROVIDER_ID,
	GLM_PROVIDER_ID,
	MISTRAL_PROVIDER_ID,
	OLLAMA_PROVIDER_ID,
	OPENAI_PROVIDER_ID,
} from "@brainstorm/sdk-types";

/** Micro-credits per credit (1 credit = 1e6 micro-credits). */
export const CREDIT_MICROS = 1_000_000;

export type ModelRate = {
	/** Model-id prefix this rate applies to (longest prefix wins). */
	readonly modelPrefix: string;
	/** Micro-credits per 1M prompt tokens (== provider $/MTok input). */
	readonly inputMicrosPerMTok: number;
	/** Micro-credits per 1M completion tokens (== provider $/MTok output). */
	readonly outputMicrosPerMTok: number;
};

type ProviderRates = {
	readonly models: readonly ModelRate[];
	readonly defaultRate: Omit<ModelRate, "modelPrefix">;
};

const M = CREDIT_MICROS; // 1 $/MTok == 1e6 micro-credits/MTok

/** Unknown cloud provider/model — priced like a mid-tier frontier model so an
 *  unpriced model never meters as free (conservative for budget enforcement). */
export const FALLBACK_CLOUD_RATE: Omit<ModelRate, "modelPrefix"> = {
	inputMicrosPerMTok: 3 * M,
	outputMicrosPerMTok: 15 * M,
};

const ZERO_RATE: Omit<ModelRate, "modelPrefix"> = {
	inputMicrosPerMTok: 0,
	outputMicrosPerMTok: 0,
};

/** Provider list prices, $/MTok, as of 2026-07. Update by pasting new prices. */
const RATES: Record<string, ProviderRates> = {
	[OLLAMA_PROVIDER_ID]: { models: [], defaultRate: ZERO_RATE },
	[ANTHROPIC_PROVIDER_ID]: {
		models: [
			{ modelPrefix: "claude-fable", inputMicrosPerMTok: 10 * M, outputMicrosPerMTok: 50 * M },
			{ modelPrefix: "claude-opus", inputMicrosPerMTok: 5 * M, outputMicrosPerMTok: 25 * M },
			{ modelPrefix: "claude-sonnet", inputMicrosPerMTok: 3 * M, outputMicrosPerMTok: 15 * M },
			{ modelPrefix: "claude-haiku", inputMicrosPerMTok: 1 * M, outputMicrosPerMTok: 5 * M },
		],
		defaultRate: { inputMicrosPerMTok: 3 * M, outputMicrosPerMTok: 15 * M },
	},
	[OPENAI_PROVIDER_ID]: {
		models: [
			{ modelPrefix: "gpt-4o-mini", inputMicrosPerMTok: 0.15 * M, outputMicrosPerMTok: 0.6 * M },
			{ modelPrefix: "gpt-4o", inputMicrosPerMTok: 2.5 * M, outputMicrosPerMTok: 10 * M },
			{ modelPrefix: "gpt-4.1-mini", inputMicrosPerMTok: 0.4 * M, outputMicrosPerMTok: 1.6 * M },
			{ modelPrefix: "gpt-4.1-nano", inputMicrosPerMTok: 0.1 * M, outputMicrosPerMTok: 0.4 * M },
			{ modelPrefix: "gpt-4.1", inputMicrosPerMTok: 2 * M, outputMicrosPerMTok: 8 * M },
			{ modelPrefix: "o3", inputMicrosPerMTok: 2 * M, outputMicrosPerMTok: 8 * M },
		],
		defaultRate: { inputMicrosPerMTok: 2.5 * M, outputMicrosPerMTok: 10 * M },
	},
	[GEMINI_PROVIDER_ID]: {
		models: [
			{ modelPrefix: "gemini-2.0-flash", inputMicrosPerMTok: 0.1 * M, outputMicrosPerMTok: 0.4 * M },
			{ modelPrefix: "gemini-2.5-flash", inputMicrosPerMTok: 0.3 * M, outputMicrosPerMTok: 2.5 * M },
			{ modelPrefix: "gemini-2.5-pro", inputMicrosPerMTok: 1.25 * M, outputMicrosPerMTok: 10 * M },
		],
		defaultRate: { inputMicrosPerMTok: 0.3 * M, outputMicrosPerMTok: 2.5 * M },
	},
	[GLM_PROVIDER_ID]: {
		models: [{ modelPrefix: "glm-4.5", inputMicrosPerMTok: 0.6 * M, outputMicrosPerMTok: 2.2 * M }],
		defaultRate: { inputMicrosPerMTok: 0.6 * M, outputMicrosPerMTok: 2.2 * M },
	},
	[MISTRAL_PROVIDER_ID]: {
		models: [
			{ modelPrefix: "mistral-large", inputMicrosPerMTok: 2 * M, outputMicrosPerMTok: 6 * M },
			{ modelPrefix: "mistral-small", inputMicrosPerMTok: 0.1 * M, outputMicrosPerMTok: 0.3 * M },
		],
		defaultRate: { inputMicrosPerMTok: 2 * M, outputMicrosPerMTok: 6 * M },
	},
};

function rateFor(provider: string, model: string): Omit<ModelRate, "modelPrefix"> {
	const entry = RATES[provider];
	if (!entry) return FALLBACK_CLOUD_RATE;
	let best: ModelRate | null = null;
	for (const rate of entry.models) {
		if (!model.startsWith(rate.modelPrefix)) continue;
		if (!best || rate.modelPrefix.length > best.modelPrefix.length) best = rate;
	}
	return best ?? entry.defaultRate;
}

/**
 * Price one call in integer micro-credits. Per-side `ceil` so a nonzero token
 * count on a nonzero rate always costs at least one micro-credit — usage can
 * round up, never down to free.
 */
export function creditsMicroForUsage(
	provider: string,
	model: string,
	promptTokens: number,
	completionTokens: number,
): number {
	const rate = rateFor(provider, model);
	const input = Math.ceil((Math.max(0, promptTokens) * rate.inputMicrosPerMTok) / 1_000_000);
	const output = Math.ceil((Math.max(0, completionTokens) * rate.outputMicrosPerMTok) / 1_000_000);
	return input + output;
}
