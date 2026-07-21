/**
 * Notes' inline formatting toolbar — a thin wrapper over the shared
 * `<InlineToolbarPlugin>` (`@brainstorm-os/editor`) that every editor consumer
 * now mounts. Notes adds two things the shared core leaves opt-in: the
 * `@`-mention + `:`-emoji overflow rows (Notes mounts both typeaheads) and the
 * inline-LaTeX "equation" row (Notes-only `EquationNode`). The B/I/U/S/code +
 * colour + link affordance, positioning and keyboard behaviour all live in the
 * shared plugin so Notes / Journal / Tasks / Bookmarks stay in lockstep.
 */

import { InlineToolbarPlugin as SharedInlineToolbarPlugin } from "@brainstorm-os/editor";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getSelection, $isRangeSelection } from "lexical";
import { type ReactNode, useCallback } from "react";
import { $createEquationNode } from "./nodes/equation-node";
import { useNoteContext } from "./note-context";

export function InlineToolbarPlugin(): ReactNode {
	const [editor] = useLexicalComposerContext();
	const { onCommentSelection } = useNoteContext();
	// Turn the selected text into an inline LaTeX equation — the selection
	// becomes the equation source (the KaTeX render replaces it in place).
	const onInsertEquation = useCallback(() => {
		editor.update(() => {
			const sel = $getSelection();
			if (!$isRangeSelection(sel) || sel.isCollapsed()) return;
			sel.insertNodes([$createEquationNode(sel.getTextContent(), true)]);
		});
	}, [editor]);
	return (
		<SharedInlineToolbarPlugin
			mention
			emoji
			onInsertEquation={onInsertEquation}
			{...(onCommentSelection ? { onComment: onCommentSelection } : {})}
		/>
	);
}
