/**
 * InsertAtEndPlugin (F-241 / doc 75) — applies a pending validated `insert`
 * request to the mounted editor: waits for the note's Y.Doc hydration
 * (`whenLoaded`), then appends the request's markdown at the end of the
 * document via `appendMarkdownAtEnd` and reports back. The host clears the
 * request in `onDone`, so a request is applied exactly once (a `nonce` ref
 * additionally pins one-shot semantics against any re-render replay).
 *
 * The host only mounts a request that already passed the fail-closed
 * decision (`decideInsertIntent`) AND matches the open note; this plugin is
 * purely the apply step in the editor's own update pipeline (one undo step,
 * normal autosave/`bodyRefs` flow — see `append-markdown.ts`).
 */

import { BASELINE_NODES, BLOCK_MARKDOWN_TRANSFORMERS } from "@brainstorm-os/editor";
import { TRANSFORMERS, type Transformer } from "@lexical/markdown";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import type { Klass, LexicalNode } from "lexical";
import { useEffect, useRef } from "react";
import { appendMarkdownAtEnd } from "./append-markdown";
import { NOTES_ADDITIONAL_NODES } from "./notes-nodes";

/** A validated, note-targeted append request. `nonce` distinguishes two
 *  otherwise-identical consecutive requests (host bumps it per intent). */
export type InsertAtEndRequest = {
	noteId: string;
	markdown: string;
	nonce: number;
};

/** Node set for the headless markdown parse — the full Notes editor node
 *  surface, so parsed blocks always re-hydrate in the rendered editor. */
const INSERT_NODES: ReadonlyArray<Klass<LexicalNode>> = [
	...BASELINE_NODES,
	...NOTES_ADDITIONAL_NODES,
];

/** Standard markdown fidelity: the shared block transformers (checklist,
 *  horizontal rule) + Lexical's canonical set. Typing-sugar transformers
 *  (emoji shortcodes, unicode chords) are deliberately absent — an inserted
 *  reply is converted content, not live typing. */
const INSERT_TRANSFORMERS: ReadonlyArray<Transformer> = [
	...BLOCK_MARKDOWN_TRANSFORMERS,
	...TRANSFORMERS,
];

export function InsertAtEndPlugin({
	request,
	whenLoaded,
	onDone,
}: {
	request: InsertAtEndRequest | null;
	/** The note doc's hydration promise (`useYDocLoaded`) — appending before
	 *  hydration would race the collab binding's initial sync. */
	whenLoaded?: Promise<void> | undefined;
	/** Called exactly once per request; `applied` is false when the markdown
	 *  parsed to nothing or the append failed. */
	onDone: (applied: boolean) => void;
}) {
	const [editor] = useLexicalComposerContext();
	const appliedNonce = useRef<number | null>(null);

	useEffect(() => {
		if (!request || appliedNonce.current === request.nonce) return;
		let alive = true;
		const apply = () => {
			if (!alive || appliedNonce.current === request.nonce) return;
			appliedNonce.current = request.nonce;
			let applied = false;
			try {
				applied = appendMarkdownAtEnd(editor, request.markdown, INSERT_NODES, INSERT_TRANSFORMERS);
			} catch (error) {
				console.error("[notes/insert] append failed:", error);
			}
			onDone(applied);
		};
		if (whenLoaded) {
			void whenLoaded.then(apply);
		} else {
			apply();
		}
		return () => {
			alive = false;
		};
	}, [request, whenLoaded, editor, onDone]);

	return null;
}
