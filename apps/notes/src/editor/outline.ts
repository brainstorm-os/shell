/**
 * Document outline (B11.26) — the headings of the open note, in document
 * order, for the side Outline panel. Pure readers over the editor state so
 * the panel can live outside the composer; `OutlinePlugin` is the one live
 * subscription.
 */

import { $isHeadingNode } from "@lexical/rich-text";
import { $getRoot, $isElementNode, type LexicalNode, type NodeKey } from "lexical";

export type OutlineEntry = {
	key: NodeKey;
	text: string;
	/** 1-based heading depth (`h1` → 1). */
	level: number;
};

function headingLevel(tag: string): number {
	const n = Number(tag.slice(1));
	return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Must run inside `editorState.read()` / `editor.read()`. Descends into
 *  container blocks (toggles, columns, callouts) so a heading nested in one
 *  is still listed; text leaves are never visited. */
export function $collectOutline(): OutlineEntry[] {
	const out: OutlineEntry[] = [];
	const stack: LexicalNode[] = [...$getRoot().getChildren()].reverse();
	while (stack.length > 0) {
		const node = stack.pop();
		if (!node) break;
		if ($isHeadingNode(node)) {
			out.push({
				key: node.getKey(),
				text: node.getTextContent().trim(),
				level: headingLevel(node.getTag()),
			});
			continue;
		}
		if ($isElementNode(node) && !node.isInline()) {
			const children = node.getChildren();
			for (let i = children.length - 1; i >= 0; i--) {
				const child = children[i];
				if (child && $isElementNode(child)) stack.push(child);
			}
		}
	}
	return out;
}

export function sameOutline(a: readonly OutlineEntry[], b: readonly OutlineEntry[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const x = a[i];
		const y = b[i];
		if (!x || !y || x.key !== y.key || x.text !== y.text || x.level !== y.level) return false;
	}
	return true;
}

/** Shallowest level present, so a doc that starts at `h2` doesn't render
 *  every row one indent in. */
export function outlineBaseLevel(entries: readonly OutlineEntry[]): number {
	let min = Number.POSITIVE_INFINITY;
	for (const e of entries) if (e.level < min) min = e.level;
	return Number.isFinite(min) ? min : 1;
}

/** The heading the reader is "in": the last one whose top has scrolled to
 *  (or above) `threshold`. Before the first heading reaches it, the first
 *  heading is active. `-1` for an empty outline. `tops` are viewport-space
 *  offsets in document order; `null` marks a heading with no DOM element. */
export function activeOutlineIndex(tops: readonly (number | null)[], threshold: number): number {
	if (tops.length === 0) return -1;
	let active = 0;
	for (let i = 0; i < tops.length; i++) {
		const top = tops[i];
		if (top === null || top === undefined) continue;
		if (top <= threshold) active = i;
		else break;
	}
	return active;
}
