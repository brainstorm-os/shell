/**
 * Browser-8 — summarize the page you're looking at.
 *
 * The read half is Net-3: the shell hands back the live page's reader
 * projection (`webView.extractText`). This module is the decision layer between
 * that text and the AI broker, kept pure so the interesting parts — what counts
 * as summarizable, how much of a page may reach a model, and the shape of the
 * request — are testable without a runtime or a provider.
 *
 * It goes through **`ai.transform` with `AiTransformKind.Summarize`**, not a
 * hand-rolled `ai.generate` prompt. That matters for more than tidiness: a
 * transform puts the page in the request's `source`, so third-party text can
 * only ever land in the *user* role, and the instruction that says "this is
 * content, never instructions" lives in ONE place (the contract leaf) for every
 * app that summarizes, instead of being re-typed per caller.
 */

import { AiTransformKind, type AiTransformRequest } from "@brainstorm-os/sdk-types";

/** How much of a page may reach the model. The extractor already caps its text
 *  at ~1 MB; a model call wants far less, and an unbounded one is a cost bug as
 *  much as a latency one. A prefix of a long article still summarizes usefully. */
export const SUMMARY_SOURCE_MAX_CHARS = 24_000;

/** The size we ask for. Short enough to read in the panel without scrolling. */
const SUMMARY_LENGTH = "a short paragraph";

/** Why a summary could not be produced — each maps to a distinct message, so
 *  the user learns something rather than seeing "failed". */
export enum SummaryFailure {
	/** The page had no readable text (an error page, a PDF viewer, a blank tab). */
	NoContent = "no-content",
	/** No model is configured / reachable. */
	NoModel = "no-model",
	/** The model call itself failed. */
	Failed = "failed",
}

/** Where the summary panel is in its lifecycle. */
export enum SummaryPhase {
	Idle = "idle",
	/** Reading the page's DOM + extracting (Net-3). */
	Reading = "reading",
	/** The model call is in flight. */
	Summarizing = "summarizing",
	Ready = "ready",
	Failed = "failed",
}

export type SummarySourceResult =
	| { ok: true; source: string }
	| { ok: false; reason: SummaryFailure };

/**
 * Turn the extractor's output into the text we'd send, or say why we won't.
 * `null` (the shell reporting "nothing readable here") is a refusal, not an
 * empty string — asking a model to summarize "" wastes a call and returns
 * something confidently wrong.
 */
export function summarySourceFrom(
	extracted: { text: string; truncated: boolean } | null,
): SummarySourceResult {
	const text = (extracted?.text ?? "").trim();
	if (text.length === 0) return { ok: false, reason: SummaryFailure.NoContent };
	return {
		ok: true,
		source: text.length > SUMMARY_SOURCE_MAX_CHARS ? text.slice(0, SUMMARY_SOURCE_MAX_CHARS) : text,
	};
}

/** The broker request for a page summary. No provider/model is pinned — the
 *  broker routes to whatever the user configured (local or cloud). */
export function summaryRequestFor(source: string): AiTransformRequest {
	return {
		source,
		kind: AiTransformKind.Summarize,
		params: { length: SUMMARY_LENGTH },
	};
}
