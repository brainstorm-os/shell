/**
 * Net-3 — the **live-DOM feeder**: the rendered DOM of a partitioned
 * `WebContentsView` handed to the SAME Net-2 extraction core the static
 * `network.readable` feeder uses, so an in-browser capture and a fetched URL
 * produce one shape (one `Bookmark/v1`, one reader projection — OQ-RX-5).
 *
 * Why the live DOM rather than a re-fetch: the page the user is looking at is
 * often not the page a second GET returns — it may be behind a login, rendered
 * by script, or personalised. Re-fetching would silently capture something
 * else. Taking the DOM the user can actually see is the honest source, and it
 * costs no extra egress.
 *
 * This module is the pure half: the size clamps and the projection into
 * {@link WebViewExtractedText}. Reading the DOM out of Electron lives in the
 * view factory (`captureHtml`), and the CPU-heavy parse stays in the extraction
 * worker — neither belongs on the broker loop.
 */

import type { WebViewExtractedText } from "@brainstorm-os/sdk-types";

/** Hard cap on the serialized DOM we accept from a page. A hostile or merely
 *  enormous document must not be able to push an unbounded string through IPC
 *  and into the parser; past this we take the prefix and let the extractor work
 *  on what it has (a truncated article beats a hung capture). */
export const LIVE_DOM_MAX_CHARS = 8_000_000;

/** Cap on the extracted TEXT, per OQ-RX-2's resolution (~1 MB + a visible
 *  truncation marker). The marker itself is the caller's to render — the flag
 *  travels on the result so the UI can say so rather than silently eliding. */
export const EXTRACTED_TEXT_MAX_CHARS = 1_000_000;

/** Clamp a page's serialized DOM before it crosses into the parser. */
export function clampLiveDomHtml(html: string): string {
	return html.length > LIVE_DOM_MAX_CHARS ? html.slice(0, LIVE_DOM_MAX_CHARS) : html;
}

/**
 * Project an extraction result into the wire shape the agentic read path
 * returns. `null` when the page yielded no readable text at all — an error
 * page, a PDF viewer, a blank tab — so the caller can say "nothing to read"
 * instead of handing an empty string to a model.
 */
export function toExtractedText(input: {
	url: string;
	/** The tab's title, used when the extractor found no better one. */
	fallbackTitle: string;
	extractedTitle?: string | null;
	textContent: string;
}): WebViewExtractedText | null {
	const text = input.textContent.trim();
	if (text.length === 0) return null;
	const truncated = text.length > EXTRACTED_TEXT_MAX_CHARS;
	const title = (input.extractedTitle ?? "").trim() || input.fallbackTitle;
	return {
		url: input.url,
		title,
		text: truncated ? text.slice(0, EXTRACTED_TEXT_MAX_CHARS) : text,
		truncated,
	};
}
