/**
 * Reader mode (Browser-5) — the pure state behind the chrome's per-tab reader
 * toggle. The article itself comes from the shell's Net-3 live-DOM extraction
 * (`webView.extractText`, gated on `web.capture`): the page's RENDERED DOM is
 * reduced to a cleaned text projection shell-side, so no page HTML ever enters
 * this renderer — the reader renders plain strings as React text nodes
 * (sanitized DOM, never raw HTML injection; the app-page CSP stands).
 */

import type { WebViewExtractedText } from "../types/web-view";

/** Where the reader is in its lifecycle. Chrome-local, per tab. */
export enum ReaderPhase {
	/** The extract round-trip is in flight. */
	Loading = "loading",
	/** An article is on screen. */
	Ready = "ready",
	/** The shell reported nothing readable (an error page, a blank tab, a
	 *  PDF viewer) — the reader shows why instead of a blank sheet. */
	Empty = "empty",
}

/** The reader belongs to ONE tab — switching tabs must not carry one tab's
 *  article (or its failure) onto another tab's page. `null` = closed. */
export type ReaderState = {
	tabId: string;
	phase: ReaderPhase;
	article: WebViewExtractedText | null;
};

/** The reader state the chrome renders for `activeTabId`: the recorded state
 *  when it belongs to that tab, else nothing (closed). */
export function readerFor(
	state: ReaderState | null,
	activeTabId: string | null,
): ReaderState | null {
	if (!state || activeTabId === null || state.tabId !== activeTabId) return null;
	return state;
}

/** Upper bound on rendered paragraphs — the extractor already caps the text at
 *  ~1 MB, but a newline-bomb must not translate into an unbounded DOM. */
export const READER_MAX_PARAGRAPHS = 2_000;

/**
 * Split the extractor's flattened text into renderable paragraphs: newline
 * runs delimit, blank lines drop, count is capped. Pure string work — the
 * output is rendered as React text nodes only.
 */
export function readerParagraphs(text: string): string[] {
	const out: string[] = [];
	for (const raw of text.split(/\n+/)) {
		const line = raw.trim();
		if (line.length === 0) continue;
		out.push(line);
		if (out.length >= READER_MAX_PARAGRAPHS) break;
	}
	return out;
}

/** Whether the reader can act on this page — mirrors the clip gate: only a
 *  real web page has a readable projection. */
export function canReader(url: string | undefined): boolean {
	if (!url) return false;
	try {
		const parsed = new URL(url);
		return parsed.protocol === "https:" || parsed.protocol === "http:";
	} catch {
		return false;
	}
}
