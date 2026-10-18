/**
 * Toggle-list outliner (B11.30) — toggles nest like an outline when the
 * caret is on a toggle's summary line:
 *   - Tab        → indent: the toggle becomes the last child of the toggle
 *                  above it (that toggle opens so the move stays visible);
 *   - Shift+Tab  → outdent: the toggle moves out to just after its parent;
 *   - Enter      → a new sibling toggle (text after the caret moves into
 *                  it); on an empty summary it outdents a nested toggle, or
 *                  turns a top-level empty toggle back into a paragraph.
 * Outside a summary line every key keeps its normal behaviour.
 *
 * Pure `$` operations — the plugin binds them to the key commands.
 */

import {
	$createParagraphNode,
	$getSelection,
	$isElementNode,
	$isRangeSelection,
	$isTextNode,
	type ElementNode,
	type LexicalNode,
} from "lexical";
import { $createToggleNode, $isToggleNode, type ToggleNode } from "../nodes/toggle-node";

/** The toggle whose summary line holds a collapsed caret, if any. */
export function $summaryToggle(): ToggleNode | null {
	const selection = $getSelection();
	if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
	let node: LexicalNode | null = selection.anchor.getNode();
	while (node) {
		const parent: ElementNode | null = node.getParent();
		if ($isToggleNode(parent)) return parent.getFirstChild() === node ? parent : null;
		node = parent;
	}
	return null;
}

function summaryOf(toggle: ToggleNode): ElementNode | null {
	const first = toggle.getFirstChild();
	return $isElementNode(first) ? first : null;
}

function bodyIsEmpty(toggle: ToggleNode): boolean {
	return toggle
		.getChildren()
		.slice(1)
		.every((child) => child.getTextContent().trim().length === 0);
}

/** Indent `toggle` under the toggle just above it. Returns the new parent
 *  (so the caller can open it), or `null` when there is nothing to nest
 *  under. */
export function $indentToggle(toggle: ToggleNode): ToggleNode | null {
	const previous = toggle.getPreviousSibling();
	if (!$isToggleNode(previous)) return null;
	const body = previous.getChildren().slice(1);
	const only = body.length === 1 ? body[0] : undefined;
	if (only && !$isToggleNode(only) && only.getTextContent().length === 0) only.replace(toggle);
	else previous.append(toggle);
	return previous;
}

/** Move `toggle` out of the toggle body it sits in. `false` at top level. */
export function $outdentToggle(toggle: ToggleNode): boolean {
	const parent = toggle.getParent();
	if (!$isToggleNode(parent) || parent.getFirstChild() === toggle) return false;
	parent.insertAfter(toggle);
	if (parent.getChildrenSize() < 2) parent.append($createParagraphNode());
	return true;
}

/** Enter on a summary line. `false` leaves the key to the default handler. */
export function $enterOnSummary(toggle: ToggleNode): boolean {
	const selection = $getSelection();
	const summary = summaryOf(toggle);
	if (!$isRangeSelection(selection) || !summary) return false;
	if (summary.getTextContentSize() === 0) {
		if ($outdentToggle(toggle)) {
			summary.selectStart();
			return true;
		}
		if (!bodyIsEmpty(toggle)) return false;
		const paragraph = $createParagraphNode();
		toggle.replace(paragraph);
		paragraph.selectStart();
		return true;
	}
	const sibling = $createToggleNode(toggle.getVariant());
	const nextSummary = $createParagraphNode();
	sibling.append(nextSummary, $createParagraphNode());
	for (const node of $collectTail(summary, selection.anchor.getNode(), selection.anchor.offset)) {
		nextSummary.append(node);
	}
	toggle.insertAfter(sibling);
	nextSummary.selectStart();
	return true;
}

/** The summary's inline content after the caret, split out of the text
 *  node the caret sits in. */
function $collectTail(
	summary: ElementNode,
	anchorNode: LexicalNode,
	offset: number,
): LexicalNode[] {
	let start: LexicalNode | null = null;
	if ($isTextNode(anchorNode)) {
		if (offset >= anchorNode.getTextContentSize()) start = anchorNode.getNextSibling();
		else if (offset === 0) start = anchorNode;
		else start = anchorNode.splitText(offset)[1] ?? null;
	} else if (anchorNode === summary) {
		start = summary.getChildAtIndex(offset);
	}
	const out: LexicalNode[] = [];
	for (let n = start; n; n = n.getNextSibling()) out.push(n);
	return out;
}
