/**
 * F-241 / doc 75 — append markdown at the end of the open note's document.
 *
 * Two-step so no live document is ever the parse target: (1) a throwaway
 * headless Lexical editor converts the markdown into blocks with the same
 * transformer set the Notes editor registers (`$convertFromMarkdownString`
 * on the headless root); (2) the serialized blocks are re-hydrated inside
 * the TARGET editor's own `editor.update` via `$parseSerializedNode` and
 * appended to its root — one update, one undo step, flushed through the
 * normal Yjs binding + autosave path exactly like typed content (snippet +
 * `bodyRefs` refresh for free, so an appended `brainstorm://entity/…` link
 * projects a graph edge like any hand-written one).
 *
 * Markdown is TEXT here: every payload string becomes text/element nodes via
 * the sanctioned transformers — nothing is interpreted as HTML or executed.
 */

import { createHeadlessEditor } from "@lexical/headless";
import { $convertFromMarkdownString, type Transformer } from "@lexical/markdown";
import {
	$getRoot,
	$parseSerializedNode,
	type Klass,
	type LexicalEditor,
	type LexicalNode,
	type SerializedLexicalNode,
} from "lexical";

/**
 * Parse markdown into serialized top-level blocks using a throwaway headless
 * editor. `nodes` must cover every node type the transformers can produce
 * (the caller passes the Notes editor's full node set so headless and
 * rendered parses can never drift).
 */
export function markdownToSerializedBlocks(
	markdown: string,
	nodes: ReadonlyArray<Klass<LexicalNode>>,
	transformers: ReadonlyArray<Transformer>,
): SerializedLexicalNode[] {
	const headless = createHeadlessEditor({
		namespace: "notes-insert-parse",
		nodes: [...nodes],
		onError(err) {
			throw err;
		},
	});
	headless.update(
		() => {
			$convertFromMarkdownString(markdown, [...transformers]);
		},
		{ discrete: true },
	);
	const root = headless.getEditorState().toJSON().root;
	return (root.children ?? []) as SerializedLexicalNode[];
}

/**
 * Append `markdown` at the end of `editor`'s document in one update.
 * Empty / whitespace-only markdown is a no-op. Throws on a parse failure
 * (the caller surfaces the refusal — never a partial write: the target
 * editor is only touched after the headless parse succeeded).
 */
export function appendMarkdownAtEnd(
	editor: LexicalEditor,
	markdown: string,
	nodes: ReadonlyArray<Klass<LexicalNode>>,
	transformers: ReadonlyArray<Transformer>,
): boolean {
	if (markdown.trim().length === 0) return false;
	const blocks = markdownToSerializedBlocks(markdown, nodes, transformers);
	if (blocks.length === 0) return false;
	// `discrete` commits synchronously — the caller (and tests) observe the
	// appended state immediately, and the whole append is one update.
	editor.update(
		() => {
			const root = $getRoot();
			for (const block of blocks) {
				root.append($parseSerializedNode(block));
			}
		},
		{ discrete: true },
	);
	return true;
}
