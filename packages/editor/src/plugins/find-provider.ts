/**
 * Notes' `TextSearchProvider` (B9.1b adapter) — bridges the shared
 * `@brainstorm-os/sdk/find-replace` controller to the Lexical editor's
 * MODEL, never the DOM (doc 59, load-bearing from OQ-185): search walks
 * `EditorState` text nodes, a `Match` is a `{nodeKey,start,end}` model
 * handle (not a DOM range), `revealMatch` sets the editor's *model*
 * selection, and replace flows through Lexical so it's collab-safe and a
 * single undo step. Correct whether or not the match's block is
 * currently rendered — the precondition virtualization ([52]) needs.
 *
 * Pure-ish: a thin wrapper over a `LexicalEditor`; fully exercised with
 * `@lexical/headless` (no renderer), the same way `table-ops` is.
 */

import {
	FIND_SEED_MAX_LEN,
	type FindBudget,
	type FindQuery,
	type FindRange,
	type Match,
	type TextSearchProvider,
	compileFindQuery,
	createFindBudget,
	expandReplacement,
	findRanges,
} from "@brainstorm-os/sdk/find-replace";
import {
	$createRangeSelection,
	$getNodeByKey,
	$getRoot,
	$getSelection,
	$isElementNode,
	$isRangeSelection,
	$isTextNode,
	$setSelection,
	type ElementNode,
	type LexicalEditor,
	type TextNode,
} from "lexical";

/** A model-addressed match: which text node, and the half-open
 *  `[start,end)` char range within that node's text. A regex match also
 *  carries its captures so a replace can expand `$1` / `$&`. */
export type LexicalMatch = FindRange & { nodeKey: string };

/** Mutations + the reveal selection must apply *synchronously*: the
 *  shared find controller re-runs `search()` and reads state immediately
 *  after `replace`/`replaceAll` (and reveals right after a step), so a
 *  default async `editor.update()` would leave it reading the stale
 *  pre-edit model. `discrete` flushes the reconcile in-call. */
const DISCRETE = { discrete: true } as const;

/** Ranges of the query in one text node, charged to the search budget
 *  (B11.27) — literal and regex share the bounded `findRanges` loop. */
function rangesIn(haystack: string, query: FindQuery): FindRange[] {
	if (query.term.length === 0) return [];
	const compiled = compileFindQuery(query);
	return findRanges(haystack, compiled, query.budget ?? createFindBudget());
}

/** Depth-first text nodes in document order — find walks the model,
 *  so offscreen / unrendered blocks are still searched. */
function collectTextNodes(node: ElementNode, out: TextNode[]): void {
	for (const child of node.getChildren()) {
		if ($isTextNode(child)) out.push(child);
		else if ($isElementNode(child)) collectTextNodes(child, out);
	}
}

/** The current ranged model selection mapped onto the ordered text-node
 *  list as `[startNodeIdx,startOffset] .. [endNodeIdx,endOffset]`
 *  (doc-order normalized). `null` when there is no usable text range —
 *  collapsed, no selection, or endpoints not text-addressable — in which
 *  case `inSelection` is a no-op (search the whole document, the
 *  least-surprising "Find in selection with nothing selected" behaviour).
 *  Must run inside `editorState.read()`. */
type SelectionSpan = {
	startIdx: number;
	startOffset: number;
	endIdx: number;
	endOffset: number;
};

function selectionSpan(textNodes: readonly TextNode[]): SelectionSpan | null {
	const sel = $getSelection();
	if (!$isRangeSelection(sel) || sel.isCollapsed()) return null;
	const indexByKey = new Map(textNodes.map((n, i) => [n.getKey(), i]));
	const a = indexByKey.get(sel.anchor.key);
	const f = indexByKey.get(sel.focus.key);
	if (a === undefined || f === undefined) return null;
	const anchor = { idx: a, off: sel.anchor.offset };
	const focus = { idx: f, off: sel.focus.offset };
	const [s, e] =
		anchor.idx < focus.idx || (anchor.idx === focus.idx && anchor.off <= focus.off)
			? [anchor, focus]
			: [focus, anchor];
	return { startIdx: s.idx, startOffset: s.off, endIdx: e.idx, endOffset: e.off };
}

/** A `[start,end)` match in ordered text node `idx` is within `span`. */
function withinSpan(span: SelectionSpan, idx: number, start: number, end: number): boolean {
	const afterStart = idx > span.startIdx || (idx === span.startIdx && start >= span.startOffset);
	const beforeEnd = idx < span.endIdx || (idx === span.endIdx && end <= span.endOffset);
	return afterStart && beforeEnd;
}

/** A per-node budget with the match + step caps but no deadline. */
function untimedBudget(): FindBudget {
	return { ...createFindBudget(), deadline: Number.POSITIVE_INFINITY };
}

export function createLexicalSearchProvider(editor: LexicalEditor): TextSearchProvider {
	const find = (query: FindQuery): LexicalMatch[] => {
		const { term, options } = query;
		const matches: LexicalMatch[] = [];
		editor.getEditorState().read(() => {
			const nodes: TextNode[] = [];
			collectTextNodes($getRoot(), nodes);
			// `in selection` restricts to the user's ranged model
			// selection; with nothing usable selected the toggle is a
			// no-op (whole-doc) — see `selectionSpan`.
			const span = options.inSelection ? selectionSpan(nodes) : null;
			const bounded: FindQuery = { term, options, budget: query.budget ?? createFindBudget() };
			nodes.forEach((node, idx) => {
				const key = node.getKey();
				for (const range of rangesIn(node.getTextContent(), bounded)) {
					if (span && !withinSpan(span, idx, range.start, range.end)) continue;
					matches.push({ ...range, nodeKey: key });
				}
			});
		});
		return matches;
	};

	return {
		get selectionRange() {
			// Informational (the B9.2 `in selection` scope is enforced in
			// `search`); exposes the current ranged span or null.
			let span: SelectionSpan | null = null;
			editor.getEditorState().read(() => {
				const nodes: TextNode[] = [];
				collectTextNodes($getRoot(), nodes);
				span = selectionSpan(nodes);
			});
			return span;
		},

		// OQ-FR-4 — prefill the find term from a non-empty selection within a
		// single text node (the common "double-click a word, ⌘F" path). A
		// collapsed, cross-node, or oversized selection returns null so the
		// bar opens with the previous term. Cross-node-same-block seeding is a
		// later refinement; one text node covers the typical case safely.
		seedTerm(): string | null {
			let seed: string | null = null;
			editor.getEditorState().read(() => {
				const sel = $getSelection();
				if (!$isRangeSelection(sel) || sel.isCollapsed()) return;
				if (sel.anchor.key !== sel.focus.key) return;
				const node = $getNodeByKey(sel.anchor.key);
				if (!node || !$isTextNode(node)) return;
				const text = node.getTextContent();
				const [a, b] =
					sel.anchor.offset <= sel.focus.offset
						? [sel.anchor.offset, sel.focus.offset]
						: [sel.focus.offset, sel.anchor.offset];
				const slice = text.slice(a, b);
				if (slice.length > 0 && slice.length <= FIND_SEED_MAX_LEN) seed = slice;
			});
			return seed;
		},

		search(query: FindQuery): Match[] {
			return find(query);
		},

		revealMatch(match: Match): void {
			const m = match as LexicalMatch;
			editor.update(() => {
				const node = $getNodeByKey(m.nodeKey);
				if (!node || !$isTextNode(node)) return;
				const sel = $createRangeSelection();
				sel.anchor.set(m.nodeKey, m.start, "text");
				sel.focus.set(m.nodeKey, m.end, "text");
				$setSelection(sel);
			}, DISCRETE);
		},

		replaceMatch(match: Match, replacement: string): void {
			const m = match as LexicalMatch;
			editor.update(() => {
				const node = $getNodeByKey(m.nodeKey);
				if (!node || !$isTextNode(node)) return;
				// Lexical's own splice → collab-safe, one undo step ([07]).
				node.spliceText(m.start, m.end - m.start, expandReplacement(replacement, m), false);
			}, DISCRETE);
		},

		replaceAll(query: FindQuery, replacement: string): number {
			let count = 0;
			// ONE transaction / ONE undo step (doc 59 + the [52]
			// don't-thrash-the-model budget). Per node, splice the matches
			// right-to-left so earlier offsets stay valid.
			editor.update(() => {
				const nodes: TextNode[] = [];
				collectTextNodes($getRoot(), nodes);
				// Every node gets its own budget, literal or regex: a shared
				// match/step/wall-clock budget silently stopped a regex
				// replace-all partway — at a point that varied run to run. Per
				// node the scan stays bounded (unsafe patterns are refused up
				// front, a segment is capped at FIND_MAX_SEGMENT_CHARS), and no
				// wall-clock cap keeps the result deterministic for one explicit
				// user action.
				for (const node of nodes) {
					const ranges = rangesIn(node.getTextContent(), {
						...query,
						budget: query.options.regex ? untimedBudget() : createFindBudget(),
					});
					for (let r = ranges.length - 1; r >= 0; r--) {
						const range = ranges[r];
						if (!range) continue;
						node.spliceText(
							range.start,
							range.end - range.start,
							expandReplacement(replacement, range),
							false,
						);
						count++;
					}
				}
			}, DISCRETE);
			return count;
		},
	};
}
