/**
 * Block-selection clipboard. Mirrors the design in
 * ` §Clipboard format`:
 *
 *   - **application/x-brainstorm-blocks** — Brainstorm-specific JSON
 *     `{ version, blocks: SerializedLexicalNode[] }`. Round-trips full
 *     structure (heading levels, list types, code fence, formatting,
 *     links). Written verbatim where the Clipboard API allows custom
 *     MIMEs (Electron's Chromium 130 does); a sentinel `<script>` tag
 *     embedded in the `text/html` payload carries the same JSON as a
 *     fallback so Brainstorm → Brainstorm paste round-trips even when
 *     the custom MIME is stripped (other apps, web-clipboard sanitizer).
 *   - **text/plain** — newline-joined text content. Universal fallback;
 *     also what other apps actually read.
 *
 * `text/html` HTML rendering is a separate add-on (depends on
 * `@lexical/html`); the deserialization side already understands the
 * sentinel-in-HTML path so it can land independently.
 *
 * Lexical doesn't expose a public deep-clone or `nodeFromJSON`; we use
 * the editor's `_nodes` registry directly to look up the class by its
 * `type` field. Treated as a v1 trade — when `@lexical/clipboard` is
 * added (alongside HTML), it can replace this helper.
 */

import { $isListItemNode, $isListNode, type ListNode } from "@lexical/list";
import {
	$getNodeByKey,
	$getRoot,
	$getSelection,
	$isElementNode,
	$isRangeSelection,
	type LexicalEditor,
	type LexicalNode,
	type NodeKey,
	type SerializedLexicalNode,
} from "lexical";

export const BRAINSTORM_MIME = "application/x-brainstorm-blocks";
export const BRAINSTORM_HTML_SENTINEL = "data-brainstorm-blocks";
const PAYLOAD_VERSION = 1;

type SerializedBlock = SerializedLexicalNode & { children?: SerializedBlock[] };

export type ClipboardPayload = {
	version: typeof PAYLOAD_VERSION;
	blocks: SerializedBlock[];
};

export function serializeBlocksAsJson(editor: LexicalEditor, keys: ReadonlySet<NodeKey>): string {
	let payload: ClipboardPayload = { version: PAYLOAD_VERSION, blocks: [] };
	editor.getEditorState().read(() => {
		payload = { version: PAYLOAD_VERSION, blocks: serializeSelectedBlocks(keys) };
	});
	return JSON.stringify(payload);
}

export function serializeBlocksAsText(editor: LexicalEditor, keys: ReadonlySet<NodeKey>): string {
	let text = "";
	editor.getEditorState().read(() => {
		const parts: string[] = [];
		for (const child of $getRoot().getChildren()) {
			if ($isListNode(child)) {
				for (const item of child.getChildren()) {
					if ($isListItemNode(item) && keys.has(item.getKey())) {
						parts.push(item.getTextContent());
					}
				}
				continue;
			}
			if (keys.has(child.getKey())) parts.push(child.getTextContent());
		}
		text = parts.join("\n\n");
	});
	return text;
}

/** Walk the root, emitting one serialized block per selected key.
 *  A consecutive run of selected list-items from the same parent list
 *  is collapsed into a single wrapper `ListNode` so paste re-creates
 *  a valid list (orphan `listitem` nodes can't live at root). */
function serializeSelectedBlocks(keys: ReadonlySet<NodeKey>): SerializedBlock[] {
	const blocks: SerializedBlock[] = [];
	for (const child of $getRoot().getChildren()) {
		if ($isListNode(child)) {
			const items = child
				.getChildren()
				.filter((c): c is LexicalNode => $isListItemNode(c) && keys.has(c.getKey()));
			if (items.length === 0) continue;
			blocks.push(serializeListSubset(child, items));
			continue;
		}
		if (keys.has(child.getKey())) blocks.push(serializeNode(child));
	}
	return blocks;
}

function serializeListSubset(list: ListNode, items: readonly LexicalNode[]): SerializedBlock {
	const wrapper = list.exportJSON() as SerializedBlock;
	wrapper.children = items.map((item) => serializeNode(item));
	return wrapper;
}

export function serializeBlocksAsHtml(editor: LexicalEditor, keys: ReadonlySet<NodeKey>): string {
	const text = serializeBlocksAsText(editor, keys);
	const json = serializeBlocksAsJson(editor, keys);
	// `<pre>` keeps newlines visible when pasted into a plain-text-only
	// surface; the sentinel script tag carries the canonical JSON so
	// Brainstorm → Brainstorm paste reads from there and ignores the
	// rendered HTML.
	return [
		'<meta charset="utf-8">',
		`<script type="application/json" ${BRAINSTORM_HTML_SENTINEL}>`,
		escapeForScript(json),
		"</script>",
		"<pre>",
		escapeHtml(text),
		"</pre>",
	].join("");
}

/** Decode a clipboard `text/html` payload, return the Brainstorm JSON
 *  if our sentinel script is present, else null. Tolerant of HTML-paste
 *  variants (clients adding their own outer wrappers around our HTML). */
export function extractBrainstormPayloadFromHtml(html: string): ClipboardPayload | null {
	const match = html.match(
		new RegExp(`<script[^>]*${BRAINSTORM_HTML_SENTINEL}[^>]*>([\\s\\S]*?)<\\/script>`, "i"),
	);
	if (!match) return null;
	const raw = match[1];
	if (!raw) return null;
	try {
		const decoded = decodeScriptText(raw.trim());
		const parsed = JSON.parse(decoded);
		if (isValidPayload(parsed)) return parsed;
	} catch {
		// fall through
	}
	return null;
}

/** Convert a plain-text blob (clipboard's universal fallback) into our
 *  serialized-block shape. Each `\n{2,}` separator becomes a new
 *  paragraph; single newlines collapse to a space so multi-line text
 *  pasted from a console stays in one block. */
export function plainTextToSerializedBlocks(text: string): SerializedBlock[] {
	const trimmed = text.replace(/\r\n?/g, "\n");
	if (trimmed.length === 0) return [];
	return trimmed.split(/\n{2,}/).map((chunk) => paragraphJson(chunk));
}

function paragraphJson(text: string): SerializedBlock {
	const children: SerializedBlock[] = text
		? [
				{
					type: "text",
					version: 1,
					format: 0,
					detail: 0,
					mode: "normal",
					style: "",
					text,
				} as unknown as SerializedBlock,
			]
		: [];
	return {
		type: "paragraph",
		version: 1,
		direction: null,
		format: "",
		indent: 0,
		children,
	} as unknown as SerializedBlock;
}

/** Parse a raw custom-MIME / direct-JSON string as our payload. */
export function parseBrainstormPayload(raw: string): ClipboardPayload | null {
	try {
		const parsed = JSON.parse(raw);
		if (isValidPayload(parsed)) return parsed;
	} catch {
		// fall through
	}
	return null;
}

/** Insert the given serialized blocks into the editor.
 *  - If `replaceKeys` is non-empty: remove those blocks first, then
 *    insert at their position (paste replacing block selection). For
 *    list-item replacements, the anchor is the predecessor *block* in
 *    document order — which may itself be a list item or a root
 *    sibling of the containing list; if there is no predecessor we
 *    insert before the next remaining block at root. Lists that lose
 *    every selected item are collapsed.
 *  - Otherwise: append at end of the root. */
export function insertBlocks(
	editor: LexicalEditor,
	blocks: readonly SerializedBlock[],
	replaceKeys: ReadonlySet<NodeKey>,
): NodeKey[] {
	if (blocks.length === 0) return [];
	const inserted: NodeKey[] = [];
	editor.update(
		() => {
			const root = $getRoot();
			let anchor: LexicalNode | null = null;
			if (replaceKeys.size > 0) {
				anchor = pickReplaceAnchor(replaceKeys);
				for (const key of replaceKeys) {
					const node = $getNodeByKey(key);
					if (node) node.remove();
				}
				for (const child of root.getChildren()) {
					if ($isListNode(child) && child.getChildrenSize() === 0) child.remove();
				}
				// If the anchor was detached as part of the removal, drop it.
				if (anchor && !anchor.isAttached()) anchor = null;
			} else {
				anchor = root.getLastChild();
			}
			let cursor: LexicalNode | null = anchor;
			for (const json of blocks) {
				const node = createNodeFromJson(editor, json);
				if (!node) continue;
				if (cursor) {
					cursor.insertAfter(node);
				} else {
					const first = root.getFirstChild();
					if (first) first.insertBefore(node);
					else root.append(node);
				}
				cursor = node;
				inserted.push(node.getKey());
			}
			if (cursor && $isElementNode(cursor)) cursor.selectEnd();
		},
		{ discrete: true },
	);
	return inserted;
}

/**
 * Insert a serialized-blocks snippet (a `ClipboardPayload` JSON string, the same
 * shape `serializeBlocksAsJson` produces) at the caret. This is the block-snippet
 * TEMPLATE insert path (B11.10) — deliberately the SAME machinery as paste, so a
 * snippet's transclusion / mention / object-link nodes carry their `entityId`
 * verbatim (OQ-TPL-2: a snippet is a reusable view of the graph, not a text
 * macro). Returns `false` on a malformed / empty payload (caller no-ops).
 *
 * Lands where the caret is: the slash-menu clears the `/…` paragraph before
 * running the command, so the caret sits in an empty top-level block — that
 * block is replaced (not appended-at-end, which is `insertBlocks`' empty-set
 * default) so the snippet appears in place.
 */
export function insertSnippet(editor: LexicalEditor, json: string): boolean {
	let payload: unknown;
	try {
		payload = JSON.parse(json);
	} catch {
		return false;
	}
	if (!isValidPayload(payload) || payload.blocks.length === 0) return false;
	let replaceKeys: ReadonlySet<NodeKey> = new Set<NodeKey>();
	editor.getEditorState().read(() => {
		const selection = $getSelection();
		if (!$isRangeSelection(selection)) return;
		try {
			const block = selection.anchor.getNode().getTopLevelElementOrThrow();
			if (block.getTextContent().trim() === "") replaceKeys = new Set([block.getKey()]);
		} catch {
			// No resolvable top-level block — fall back to append-at-end.
		}
	});
	insertBlocks(editor, payload.blocks, replaceKeys);
	return true;
}

/** Find the block immediately preceding the first selected key in
 *  document-block order, walking out of any containing list. Returns
 *  `null` when the selection starts at the very first block — caller
 *  inserts before the next remaining block. Must run inside an
 *  `editor.update` callback. */
function pickReplaceAnchor(replaceKeys: ReadonlySet<NodeKey>): LexicalNode | null {
	let firstSelected: LexicalNode | null = null;
	for (const key of replaceKeys) {
		const node = $getNodeByKey(key);
		if (node) {
			firstSelected = node;
			break;
		}
	}
	if (!firstSelected) return null;
	// Walk up to the containing root-child (the ListNode if `firstSelected`
	// is a list item, else the block itself). The anchor is the previous
	// sibling of that root-child.
	const rootChild = ascendToRootChild(firstSelected);
	if (!rootChild) return null;
	return rootChild.getPreviousSibling();
}

function ascendToRootChild(node: LexicalNode): LexicalNode | null {
	let current: LexicalNode | null = node;
	while (current) {
		const parent: LexicalNode | null = current.getParent();
		if (!parent) return null;
		if (parent === $getRoot()) return current;
		current = parent;
	}
	return null;
}

// ─── Internals ───────────────────────────────────────────────────────────

function serializeNode(node: LexicalNode): SerializedBlock {
	const json = node.exportJSON() as SerializedBlock;
	if ($isElementNode(node)) {
		json.children = node.getChildren().map(serializeNode);
	}
	return json;
}

type NodeCtor = { importJSON: (serialized: SerializedLexicalNode) => LexicalNode };
type EditorWithRegistry = LexicalEditor & {
	_nodes: Map<string, { klass: NodeCtor }>;
};

function createNodeFromJson(editor: LexicalEditor, json: SerializedBlock): LexicalNode | null {
	const registry = (editor as EditorWithRegistry)._nodes;
	const entry = registry.get(json.type);
	if (!entry) return null;
	const node = entry.klass.importJSON(json);
	if ($isElementNode(node) && Array.isArray(json.children)) {
		// importJSON may have already populated children; clear and rebuild
		// from the serialized tree so deeply-nested formatting round-trips.
		for (const child of node.getChildren()) child.remove();
		for (const childJson of json.children) {
			const childNode = createNodeFromJson(editor, childJson);
			if (childNode) node.append(childNode);
		}
	}
	return node;
}

function isValidPayload(value: unknown): value is ClipboardPayload {
	if (!value || typeof value !== "object") return false;
	const v = value as Partial<ClipboardPayload>;
	return v.version === PAYLOAD_VERSION && Array.isArray(v.blocks);
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function escapeForScript(text: string): string {
	// Inside `<script type="application/json">`, only `</script>` ends the
	// block — escape the closing tag so embedded JSON can't break out.
	return text.replace(/<\/script/gi, "<\\/script");
}

function decodeScriptText(text: string): string {
	return text.replace(/<\\\/script/gi, "</script");
}
