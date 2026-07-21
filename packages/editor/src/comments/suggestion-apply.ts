/**
 * Suggestion apply (B11.9) — turns an open suggestion thread's proposed edit
 * into a real editor mutation. The anchor is the (session) block id + the
 * quoted text captured at suggestion time + an optional sub-block `range`;
 * apply edits the anchored block at that range (when present) or at the quote's
 * sole occurrence (when absent) and replaces it with the suggestion's
 * `replacement` (empty replacement = delete the quote). Returns `false` — never
 * throws — when the anchor is stale: the block is gone, its text drifted so the
 * range no longer holds the quote, or (without a range) the quote is absent or
 * occurs more than once (ambiguous — editing the wrong run is worse than not
 * applying). The panel surfaces `false` as "couldn't apply" and leaves the
 * thread open for a human to reconcile.
 *
 * Pure Lexical core (`$applySuggestionToBlock`, run inside an update) +
 * a host-facing wrapper over a live editor, so the logic is headless-tested.
 */

import type { CommentAnchor } from "@brainstorm-os/sdk-types";
import {
	$createRangeSelection,
	$getNodeByKey,
	$isElementNode,
	$setSelection,
	type LexicalEditor,
	type TextNode,
} from "lexical";

/** A resolved (node, offset) endpoint for the quote's range. */
type TextPoint = { node: TextNode; offset: number };

/** Map a flat offset over the block's concatenated text back to a
 *  (text node, in-node offset) point. `preferStartOfNext` picks the next
 *  node's offset 0 over the previous node's end when the offset falls on a
 *  node boundary — right for a range start; the inverse is right for an end. */
function locate(texts: TextNode[], offset: number, preferStartOfNext: boolean): TextPoint | null {
	let acc = 0;
	for (const node of texts) {
		const len = node.getTextContentSize();
		const within = preferStartOfNext ? offset < acc + len : offset <= acc + len && offset > acc;
		if (within || (preferStartOfNext && offset === acc)) {
			return { node, offset: offset - acc };
		}
		acc += len;
	}
	// A range end exactly at the total length lands on the last node's end.
	const last = texts[texts.length - 1];
	if (!preferStartOfNext && last && offset === acc) {
		return { node: last, offset: last.getTextContentSize() };
	}
	return null;
}

/** Resolve the [start, end) character range of the quote within `joined`.
 *  When `range` is given it is authoritative — the quote must still sit at (or
 *  immediately around) it, else the text drifted and the suggestion is stale
 *  (`null`). Without a range, the indexOf fallback applies ONLY when the quote
 *  occurs exactly once; an ambiguous multi-occurrence is stale (`null`) rather
 *  than risk editing the wrong run. */
function resolveQuoteRange(
	joined: string,
	quote: string,
	range: { start: number; end: number } | undefined,
): { start: number; end: number } | null {
	if (range !== undefined) {
		if (range.start < 0 || range.end > joined.length || range.end < range.start) return null;
		if (joined.slice(range.start, range.end) !== quote) return null;
		return { start: range.start, end: range.end };
	}
	const first = joined.indexOf(quote);
	if (first < 0) return null;
	if (joined.indexOf(quote, first + 1) >= 0) return null;
	return { start: first, end: first + quote.length };
}

/**
 * Replace `quote` inside the block identified by `blockKey` with `replacement`.
 * Must run inside `editor.update()`. When `range` is present the edit lands at
 * that character span (validated against the block's current text); otherwise
 * the quote must occur exactly once. Returns `false` (no mutation) when the
 * block is missing / not an element, the quote is empty or spans blocks
 * (contains a newline — a single block's joined text can never match), the
 * range drifted, or the quote is absent / ambiguous.
 */
export function $applySuggestionToBlock(
	blockKey: string,
	quote: string,
	replacement: string,
	range?: { start: number; end: number },
): boolean {
	if (quote.length === 0 || quote.includes("\n")) return false;
	const block = $getNodeByKey(blockKey);
	if (!block || !$isElementNode(block)) return false;

	const texts = block.getAllTextNodes();
	const joined = texts.map((t) => t.getTextContent()).join("");
	const resolved = resolveQuoteRange(joined, quote, range);
	if (resolved === null) return false;

	const anchorPoint = locate(texts, resolved.start, true);
	const focusPoint = locate(texts, resolved.end, false);
	if (!anchorPoint || !focusPoint) return false;

	const selection = $createRangeSelection();
	selection.anchor.set(anchorPoint.node.getKey(), anchorPoint.offset, "text");
	selection.focus.set(focusPoint.node.getKey(), focusPoint.offset, "text");
	$setSelection(selection);
	if (replacement.length === 0) selection.removeText();
	else selection.insertText(replacement);
	return true;
}

/**
 * Host-facing wrapper: apply a suggestion's proposed edit to a live editor.
 * Synchronous (`discrete` update) so the caller can resolve the thread only
 * after the edit actually landed.
 */
export function applySuggestionInEditor(
	editor: LexicalEditor,
	anchor: CommentAnchor,
	replacement: string | undefined,
): boolean {
	// A `discrete` update bypasses the `editable` flag, so a page-locked
	// (B11.11) read-only document would otherwise be mutable from the
	// Comments panel. Refuse to apply into a non-editable editor.
	if (!editor.isEditable()) return false;
	const quote = anchor.quote;
	if (quote === undefined || quote.length === 0 || replacement === undefined) return false;
	let applied = false;
	editor.update(
		() => {
			applied = $applySuggestionToBlock(anchor.blockId, quote, replacement, anchor.range);
		},
		{ discrete: true },
	);
	return applied;
}
