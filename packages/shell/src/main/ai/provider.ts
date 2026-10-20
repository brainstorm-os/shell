/**
 * `ModelProvider` — the AI broker's provider seam (doc 22 §Architecture —
 * "apps don't pick providers; the shell routes per user configuration").
 *
 * A provider turns an `AiGenerateRequest` (a transcript) into an
 * `AiGenerateResult` (a completion). The Agent app and the Automations
 * `AICall`/`AIAgent` steps both reach a provider through the broker `ai`
 * service — never directly. v1-beta ships one provider (local Ollama,
 * BYO per OQ-60); cloud providers register behind the same interface.
 *
 * The v1 slice is single-shot `generate`. Token-streaming (a `generateStream`
 * over a push channel) is the next rung and is additive to this interface.
 */

import type { AiGenerateRequest, AiGenerateResult } from "@brainstorm-os/sdk-types";

export interface ModelProvider {
	readonly id: string;
	generate(req: AiGenerateRequest, signal?: AbortSignal): Promise<AiGenerateResult>;
}

/** An error whose `name` the broker maps to a `DenialReason`. Provider /
 *  routing failures surface as `Unavailable` (the model server is down,
 *  unconfigured, or returned a bad response) — never silent approval. */
export class AiServiceError extends Error {
	override readonly name: "Unavailable" | "Invalid";
	constructor(kind: "Unavailable" | "Invalid", message: string) {
		super(message);
		this.name = kind;
	}
}

/** Build the `AiGenerateResult["usage"]` block from whatever token counts a
 *  provider reported — shared so every provider maps usage identically.
 *  Returns `undefined` when the counts cannot be trusted, so the broker
 *  estimates instead: a user-added endpoint is arbitrary code and may report
 *  zero, negative or partial usage to dodge its per-app budget. Every call
 *  that reaches here produced a completion, so both counts are > 0. */
export function buildUsage(
	promptTokens?: number,
	completionTokens?: number,
): { promptTokens: number; completionTokens: number; totalTokens: number } | undefined {
	if (!isPositiveCount(promptTokens) || !isPositiveCount(completionTokens)) return undefined;
	return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

function isPositiveCount(n: unknown): n is number {
	return typeof n === "number" && Number.isSafeInteger(n) && n > 0;
}
