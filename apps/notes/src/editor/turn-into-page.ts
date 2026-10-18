/**
 * "Turn into page" (B11.25) — the selected blocks move into a new Note, and a
 * sub-page link (the same `PageRefNode` `/subpage` inserts) takes their place.
 *
 * Ordering is chosen so content is never lost:
 *   1. snapshot the blocks (the block-clipboard serializer — list items keep
 *      their list, block backgrounds ride along);
 *   2. create the Note and plant the snapshot into its Y.Doc (through the
 *      renderer resolver, like the vault body migration);
 *   3. only then swap the blocks for the link, in ONE editor update — so a
 *      single undo restores the blocks and removes the link together.
 * A failure in 1–2 leaves the document untouched. If the blocks were edited
 * while the page was being written, the swap is skipped (the page keeps the
 * earlier copy and the document keeps the edit) rather than discarding the
 * newer text.
 *
 * The first selected block's text becomes the page title; a lone block (or a
 * multi-block selection's first plain block) is consumed as the title rather
 * than duplicated into the body.
 */

import {
	TITLE_NODE_TYPE,
	parseBrainstormPayload,
	serializeBlocksAsJson,
} from "@brainstorm-os/editor";
import { isUniversalBodyEmpty } from "@brainstorm-os/react-yjs";
import type { YDocResolver } from "@brainstorm-os/react-yjs";
import { $isListItemNode, $isListNode } from "@lexical/list";
import {
	$createParagraphNode,
	$getNodeByKey,
	$getRoot,
	$isElementNode,
	type LexicalEditor,
	type LexicalNode,
	type NodeKey,
	type SerializedEditorState,
	type SerializedLexicalNode,
} from "lexical";
import type { Doc } from "yjs";
import { migrateTitleIntoBody } from "./migrate-title";
import { $createPageRefNode } from "./nodes/page-ref-node";

export const PAGE_ENTITY_TYPE = "io.brainstorm.notes/Note/v1";

const TITLE_MAX = 200;

export type TurnIntoPageDeps = {
	create: (type: string, properties: Record<string, unknown>, id: string) => Promise<unknown>;
	resolve: YDocResolver;
	whenLoaded?: (entityId: string) => Promise<void>;
	plant: (doc: Doc, state: SerializedEditorState) => void;
	newId: () => string;
	now?: () => number;
};

export type PageSnapshot = {
	/** Selected blocks, document order (a list item stays a list item). */
	keys: NodeKey[];
	title: string;
	state: SerializedEditorState;
	/** The serialized blocks at snapshot time — the swap re-checks it. */
	fingerprint: string;
};

function blockOrder(editor: LexicalEditor, keys: ReadonlySet<NodeKey>): NodeKey[] {
	return editor.getEditorState().read(() => {
		const out: NodeKey[] = [];
		const walk = (node: LexicalNode) => {
			if (keys.has(node.getKey())) {
				out.push(node.getKey());
				return;
			}
			if ($isElementNode(node)) for (const child of node.getChildren()) walk(child);
		};
		walk($getRoot());
		return out;
	});
}

/** Snapshot the selected blocks as a new page's body. `null` for an empty
 *  selection or one that contains the page title. */
export function snapshotBlocksAsPage(
	editor: LexicalEditor,
	keys: ReadonlySet<NodeKey>,
): PageSnapshot | null {
	const ordered = blockOrder(editor, keys);
	const firstKey = ordered[0];
	if (!firstKey) return null;
	const { title, consumesFirst, touchesTitle } = editor.getEditorState().read(() => {
		const first = $getNodeByKey(firstKey);
		const anyTitle = ordered.some((k) => $getNodeByKey(k)?.getType() === TITLE_NODE_TYPE);
		return {
			title: (first?.getTextContent() ?? "").trim().slice(0, TITLE_MAX),
			consumesFirst:
				first !== null && first.getParent()?.is($getRoot()) === true && !$isListNode(first),
			touchesTitle: anyTitle,
		};
	});
	if (touchesTitle) return null;
	const fingerprint = serializeBlocksAsJson(editor, new Set(ordered));
	const payload = parseBrainstormPayload(fingerprint);
	if (!payload) return null;
	const blocks = consumesFirst ? payload.blocks.slice(1) : payload.blocks;
	const bare: SerializedEditorState = {
		root: {
			type: "root",
			version: 1,
			direction: null,
			format: "",
			indent: 0,
			children: blocks as SerializedLexicalNode[],
		},
	} as SerializedEditorState;
	const state = migrateTitleIntoBody(bare, title) as SerializedEditorState;
	return { keys: ordered, title, state, fingerprint };
}

/** Swap the snapshot's blocks for a page link in one update. Returns false
 *  (and changes nothing) when the blocks moved on since the snapshot. */
export function replaceBlocksWithPageRef(
	editor: LexicalEditor,
	snapshot: PageSnapshot,
	pageId: string,
): boolean {
	const keys = new Set(snapshot.keys);
	const live = blockOrder(editor, keys);
	if (live.length !== snapshot.keys.length) return false;
	if (serializeBlocksAsJson(editor, keys) !== snapshot.fingerprint) return false;
	let swapped = false;
	editor.update(
		() => {
			const first = $getNodeByKey(snapshot.keys[0] as NodeKey);
			if (!first) return;
			const ref = $createPageRefNode(pageId, PAGE_ENTITY_TYPE, snapshot.title);
			if ($isListItemNode(first)) {
				const previous = first.getPreviousSibling();
				if (previous) previous.insertAfter(ref);
				else first.getParentOrThrow().insertBefore(ref);
			} else {
				first.insertBefore(ref);
			}
			const touchedLists = new Set<NodeKey>();
			for (const key of snapshot.keys) {
				const node = $getNodeByKey(key);
				if (!node) continue;
				const parent = node.getParent();
				if ($isListNode(parent)) touchedLists.add(parent.getKey());
				node.remove();
			}
			for (const key of touchedLists) {
				const list = $getNodeByKey(key);
				if ($isListNode(list) && list.getChildrenSize() === 0) list.remove();
			}
			if (!ref.getNextSibling()) ref.insertAfter($createParagraphNode());
			const next = ref.getNextSibling();
			if ($isElementNode(next)) next.selectStart();
			swapped = true;
		},
		{ discrete: true },
	);
	return swapped;
}

/** Write a snapshot into a brand-new page's Y.Doc. */
export async function plantPage(
	pageId: string,
	snapshot: PageSnapshot,
	deps: Pick<TurnIntoPageDeps, "resolve" | "whenLoaded" | "plant">,
): Promise<void> {
	const handle = deps.resolve(pageId);
	try {
		if (deps.whenLoaded) await deps.whenLoaded(pageId);
		if (!isUniversalBodyEmpty(handle.doc)) throw new Error("new page already has a body");
		deps.plant(handle.doc, snapshot.state);
	} finally {
		handle.release();
	}
}

/** The whole flow. Resolves to the new page id, or `null` when nothing moved. */
export async function turnBlocksIntoPage(
	editor: LexicalEditor,
	keys: ReadonlySet<NodeKey>,
	deps: TurnIntoPageDeps,
): Promise<string | null> {
	const snapshot = snapshotBlocksAsPage(editor, keys);
	if (!snapshot) return null;
	const id = deps.newId();
	const now = (deps.now ?? Date.now)();
	await deps.create(PAGE_ENTITY_TYPE, { title: snapshot.title, createdAt: now, updatedAt: now }, id);
	await plantPage(id, snapshot, deps);
	if (!replaceBlocksWithPageRef(editor, snapshot, id)) {
		console.warn("[notes/turn-into-page] blocks changed while the page was written — kept both.");
	}
	return id;
}
