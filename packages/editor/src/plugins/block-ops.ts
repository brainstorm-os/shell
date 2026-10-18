/**
 * Block reorder + duplicate operations. Used by:
 *   - keyboard chords on block-selection (`Cmd+Shift+↑/↓`, `Cmd+D`),
 *   - the block-action menu entries (`Move up`, `Move down`, `Duplicate`),
 *   - any future programmatic surface that wants the same semantics.
 *
 * "Block" here matches [[top-level-block.getAllBlocks]] — a direct
 * child of root *or* a `ListItemNode`. List items move within their
 * parent `ListNode`; root blocks move among root's children. A
 * selection that spans multiple parents (e.g. some paragraphs at root
 * + some items inside a list) is grouped by parent and each group
 * shifts within its own sibling list — a "best effort" semantic so
 * keyboard chords don't silently no-op when the user has both kinds
 * of blocks selected.
 *
 * Move semantics: instead of shifting every selected block, the sibling
 * adjacent to the selected run is removed and re-inserted on the
 * opposite side. Net effect: the selected run moves by one position,
 * the selection set is unchanged. Single swap, independent of count.
 *
 * Duplicate uses a recursive `exportJSON` → `importJSON` clone, since
 * Lexical doesn't expose a public deep-clone helper. importJSON
 * recreates the node attributes; children are appended by recursion.
 *
 * All public functions pass `{ discrete: true }` so the mutation
 * commits synchronously — these are one-shot user actions, perf isn't
 * the concern, and a sync commit lets callers read the post-state
 * (e.g. `duplicateBlocks` returns the new keys for the selection
 * store).
 */

import { $createListNode, $isListItemNode, $isListNode } from "@lexical/list";
import {
	$getNodeByKey,
	$getRoot,
	$isElementNode,
	$isRootNode,
	$isTextNode,
	type ElementNode,
	type LexicalEditor,
	type LexicalNode,
	type NodeKey,
	type SerializedLexicalNode,
	type TextFormatType,
	type TextNode,
} from "lexical";
import { blockParentOf } from "../top-level-block";

const DISCRETE = { discrete: true } as const;

/** Group `keys` by their block-parent (root, or a containing ListNode).
 *  Detached / orphan keys are dropped. Within each group the returned
 *  array is ordered by the node's position in the parent — required by
 *  every move/duplicate algorithm below. Must run inside `editor.read`
 *  or an `editor.update` callback. */
function groupKeysByParent(keys: ReadonlySet<NodeKey>): Map<ElementNode, LexicalNode[]> {
	const buckets = new Map<ElementNode, LexicalNode[]>();
	for (const key of keys) {
		const node = $getNodeByKey(key);
		if (!node) continue;
		const parent = blockParentOf(node);
		if (!parent || !$isElementNode(parent)) continue;
		let bucket = buckets.get(parent);
		if (!bucket) {
			bucket = [];
			buckets.set(parent, bucket);
		}
		bucket.push(node);
	}
	for (const [parent, group] of buckets) {
		const siblings = parent.getChildren();
		const indexOf = new Map<NodeKey, number>();
		siblings.forEach((c, i) => indexOf.set(c.getKey(), i));
		group.sort((a, b) => (indexOf.get(a.getKey()) ?? 0) - (indexOf.get(b.getKey()) ?? 0));
	}
	return buckets;
}

export function moveBlocksUp(editor: LexicalEditor, keys: ReadonlySet<NodeKey>): void {
	if (keys.size === 0) return;
	editor.update(() => {
		for (const [parent, group] of groupKeysByParent(keys)) {
			const siblings = parent.getChildren();
			const groupKeys = new Set(group.map((n) => n.getKey()));
			const firstIdx = siblings.findIndex((c) => groupKeys.has(c.getKey()));
			if (firstIdx <= 0) continue;
			const above = siblings[firstIdx - 1];
			const last = group[group.length - 1];
			if (!above || !last) continue;
			above.remove();
			last.insertAfter(above);
		}
	}, DISCRETE);
}

export function moveBlocksDown(editor: LexicalEditor, keys: ReadonlySet<NodeKey>): void {
	if (keys.size === 0) return;
	editor.update(() => {
		for (const [parent, group] of groupKeysByParent(keys)) {
			const siblings = parent.getChildren();
			const groupKeys = new Set(group.map((n) => n.getKey()));
			const lastIdx = findLastSelectedIndex(siblings, groupKeys);
			if (lastIdx < 0 || lastIdx >= siblings.length - 1) continue;
			const below = siblings[lastIdx + 1];
			const first = group[0];
			if (!below || !first) continue;
			below.remove();
			first.insertBefore(below);
		}
	}, DISCRETE);
}

export function duplicateBlocks(editor: LexicalEditor, keys: ReadonlySet<NodeKey>): NodeKey[] {
	if (keys.size === 0) return [];
	const newKeys: NodeKey[] = [];
	editor.update(() => {
		for (const [, group] of groupKeysByParent(keys)) {
			if (group.length === 0) continue;
			let cursor: LexicalNode = group[group.length - 1] as LexicalNode;
			for (const original of group) {
				const cloned = deepCloneNode(original);
				cursor.insertAfter(cloned);
				cursor = cloned;
				newKeys.push(cloned.getKey());
			}
		}
	}, DISCRETE);
	return newKeys;
}

/** Shift every selected block's indent by one level (or drop a level when
 *  `outdent`, clamped at zero). The single-block path runs
 *  `INDENT_CONTENT_COMMAND` against the range selection; this drives off the
 *  block-selection key set so a multi-block selection indents together. The
 *  selection set itself is unchanged — Tab can repeat. Detached / non-element
 *  keys are skipped. */
export function indentBlocks(
	editor: LexicalEditor,
	keys: ReadonlySet<NodeKey>,
	outdent: boolean,
): void {
	if (keys.size === 0) return;
	editor.update(() => {
		for (const key of keys) {
			const node = $getNodeByKey(key);
			if (!node || !$isElementNode(node)) continue;
			const current = node.getIndent();
			const next = outdent ? Math.max(0, current - 1) : current + 1;
			if (next !== current) node.setIndent(next);
		}
	}, DISCRETE);
}

/** Collect every TextNode descendant of `node` (inclusive). */
function collectTextNodes(node: LexicalNode, out: TextNode[]): void {
	if ($isTextNode(node)) {
		out.push(node);
		return;
	}
	if ($isElementNode(node)) {
		for (const child of node.getChildren()) collectTextNodes(child, out);
	}
}

/** Toggle an inline text `format` (strikethrough / code / bold / …) across
 *  every text node inside the selected blocks. Mirrors Lexical's range
 *  `FORMAT_TEXT_COMMAND` semantics — removed when every text node already
 *  carries it, added everywhere otherwise — but drives off the block-selection
 *  key set instead of a caret range. A bridged element-boundary selection
 *  can't be formatted by `formatText` (it operates point-to-point within text),
 *  so the multi-block mark path edits the text nodes directly. The selection
 *  set is unchanged. */
export function formatTextInBlocks(
	editor: LexicalEditor,
	keys: ReadonlySet<NodeKey>,
	format: TextFormatType,
): void {
	if (keys.size === 0) return;
	editor.update(() => {
		const texts: TextNode[] = [];
		for (const key of keys) {
			const node = $getNodeByKey(key);
			if (node) collectTextNodes(node, texts);
		}
		if (texts.length === 0) return;
		const removing = texts.every((t) => t.hasFormat(format));
		for (const t of texts) {
			if (t.hasFormat(format) === removing) t.toggleFormat(format);
		}
	}, DISCRETE);
}

type NodeCtor = { importJSON: (serialized: SerializedLexicalNode) => LexicalNode };

export function deepCloneNode(node: LexicalNode): LexicalNode {
	const ctor = node.constructor as unknown as NodeCtor;
	const cloned = ctor.importJSON(node.exportJSON());
	if ($isElementNode(node) && $isElementNode(cloned)) {
		// Lexical 0.21's element `exportJSON` drops `style` (the block
		// background lives there, B11.23) — carry it across explicitly.
		cloned.setStyle(node.getStyle());
		// Some node types pre-fill children inside importJSON (rare, but
		// belt-and-braces). Reset before re-appending the original's tree.
		for (const child of cloned.getChildren()) child.remove();
		for (const child of node.getChildren()) {
			cloned.append(deepCloneNode(child));
		}
	}
	return cloned;
}

function findLastSelectedIndex(
	children: readonly LexicalNode[],
	keys: ReadonlySet<NodeKey>,
): number {
	for (let i = children.length - 1; i >= 0; i--) {
		const child = children[i];
		if (child && keys.has(child.getKey())) return i;
	}
	return -1;
}

/** Drag-to-reorder: move the selected blocks so they sit immediately
 *  before the block keyed `targetKey`. `targetKey === null` appends
 *  after the document's last block.
 *
 *  Cross-parent rules (paragraph ↔ list item):
 *  - Same-parent reorder (P→P at root, LI→LI in the same list): insert
 *    before the target as-is.
 *  - A list item dragged onto a non-list target — or appended at root —
 *    keeps list-item identity; Lexical wraps stray list items in a fresh
 *    `ListNode` via `isParentRequired()`, but we wrap explicitly so the
 *    in-update tree is valid (the structural-invariant check the broken
 *    code hit was Lexical rejecting a non-listitem child inside a
 *    `ListNode`).
 *  - A non-list block dragged onto a list-item target inserts at root
 *    just before the containing `ListNode` (the user gets "above the
 *    list" instead of "inside the list"). The alternative — splitting
 *    the list at the target item — is a larger feature; for v1 the
 *    rule is "lists stay intact unless every drop is list-item to
 *    list-item". */
export function moveBlocksTo(
	editor: LexicalEditor,
	keys: ReadonlySet<NodeKey>,
	targetKey: NodeKey | null,
): void {
	if (keys.size === 0) return;
	if (targetKey !== null && keys.has(targetKey)) return;
	editor.update(() => {
		const selected: LexicalNode[] = [];
		for (const key of keys) {
			const node = $getNodeByKey(key);
			if (node) selected.push(node);
		}
		if (selected.length === 0) return;
		selected.sort(compareDocumentOrder);

		if (targetKey === null) {
			appendSelectedAtRootEnd(selected);
			return;
		}
		const target = $getNodeByKey(targetKey);
		if (!target) return;
		insertSelectedBefore(target, selected);
	}, DISCRETE);
}

function appendSelectedAtRootEnd(selected: readonly LexicalNode[]): void {
	const root = $getRoot();
	const selectedSet = new Set(selected);
	let anchor: LexicalNode | null = null;
	const rootChildren = root.getChildren();
	for (let i = rootChildren.length - 1; i >= 0; i--) {
		const child = rootChildren[i];
		if (!child) continue;
		if (selectedSet.has(child)) continue;
		anchor = child;
		break;
	}
	if (!anchor) return;
	let cursor: LexicalNode = anchor;
	for (const node of selected) {
		const wrapped = prepareForRootSibling(node);
		wrapped.remove();
		cursor.insertAfter(wrapped);
		cursor = wrapped;
	}
}

function insertSelectedBefore(target: LexicalNode, selected: readonly LexicalNode[]): void {
	const targetParent = target.getParent();
	if (!targetParent) return;
	// Resolve the "anchor at root" — used whenever a selected node can't
	// legally live next to `target`. Falls back to root if the target is at
	// a level we don't normally render (defensive — should always resolve).
	const rootChild = ascendToRootChild(target);
	for (const node of selected) {
		const nodeParent = node.getParent();
		if (nodeParent === targetParent) {
			node.remove();
			target.insertBefore(node);
			continue;
		}
		// Cross-parent. Pick the right side.
		const targetIsListItem = $isListItemNode(target);
		const nodeIsListItem = $isListItemNode(node);
		if (targetIsListItem && nodeIsListItem) {
			// Both list items, different lists — graft into target's list.
			node.remove();
			target.insertBefore(node);
			continue;
		}
		if (!rootChild) continue;
		if (nodeIsListItem && !targetIsListItem) {
			// List-item being dropped onto a root block — wrap in a fresh list
			// so the tree stays valid in-update.
			node.remove();
			const wrap = $createListNode(getListTypeForOrphan(nodeParent));
			wrap.append(node);
			rootChild.insertBefore(wrap);
			continue;
		}
		// Non-list block dropped on a list-item target — insert at root,
		// above the containing list.
		node.remove();
		rootChild.insertBefore(node);
	}
}

/** Wrap a stray list item so it can stand at root as a sibling of other
 *  root children. No-op for already-root-safe nodes. */
function prepareForRootSibling(node: LexicalNode): LexicalNode {
	if (!$isListItemNode(node)) return node;
	const oldParent = node.getParent();
	const wrap = $createListNode(getListTypeForOrphan(oldParent));
	wrap.append(node);
	return wrap;
}

function getListTypeForOrphan(oldParent: LexicalNode | null): "bullet" | "number" | "check" {
	if (oldParent && $isListNode(oldParent)) return oldParent.getListType();
	return "bullet";
}

function ascendToRootChild(node: LexicalNode): LexicalNode | null {
	let cur: LexicalNode | null = node;
	while (cur) {
		const parent: LexicalNode | null = cur.getParent();
		if (!parent) return null;
		if ($isRootNode(parent)) return cur;
		cur = parent;
	}
	return null;
}

function compareDocumentOrder(a: LexicalNode, b: LexicalNode): number {
	// Walk both ancestor chains to root, then compare the first differing
	// ancestor's index within its parent. Stable for any two attached nodes.
	const aChain: LexicalNode[] = [];
	for (let cur: LexicalNode | null = a; cur; cur = cur.getParent()) aChain.unshift(cur);
	const bChain: LexicalNode[] = [];
	for (let cur: LexicalNode | null = b; cur; cur = cur.getParent()) bChain.unshift(cur);
	const limit = Math.min(aChain.length, bChain.length);
	for (let i = 0; i < limit; i++) {
		const an = aChain[i];
		const bn = bChain[i];
		if (an === bn) continue;
		const ai = an?.getIndexWithinParent() ?? 0;
		const bi = bn?.getIndexWithinParent() ?? 0;
		return ai - bi;
	}
	return aChain.length - bChain.length;
}
