/**
 * BlockContextMenuPlugin — right-click on any block opens the same shared
 * `openBlockActionMenu` (fancy-menus) the gutter grip uses. Seeds the block
 * selection to the clicked block when the click landed outside the existing
 * selection; clicks landing on a multi-block selection leave it intact so menu
 * commands act on the whole set.
 *
 * `contextmenu` is intercepted (preventDefault) so the native menu doesn't
 * appear; the cursor's `clientX/Y` becomes a 1×1 synthetic rect the menu
 * anchors against.
 */

import { openBlockActionMenu, useBlockSelectionStore, useEditorT } from "@brainstorm-os/editor";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getNearestNodeFromDOMNode, type NodeKey } from "lexical";
import { useEffect } from "react";
import { BLOCK_ACTIONS } from "./commands";
import { useNoteContext } from "./note-context";

export function BlockContextMenuPlugin() {
	const [editor] = useLexicalComposerContext();
	const selectionStore = useBlockSelectionStore();
	const t = useEditorT();
	const { noteId } = useNoteContext();

	useEffect(() => {
		const root = editor.getRootElement();
		if (!root) return;

		function onContextMenu(event: MouseEvent) {
			if (!(event.target instanceof Node)) return;
			let blockKey: NodeKey | null = null;
			// `$getNearestNodeFromDOMNode` needs an active *editor* — route
			// through `editor.read(...)` rather than `editorState.read(...)`.
			editor.read(() => {
				const node = $getNearestNodeFromDOMNode(event.target as Node);
				if (!node) return;
				try {
					blockKey = node.getTopLevelElementOrThrow().getKey();
				} catch {
					// click hit the root itself — nothing to act on
				}
			});
			if (!blockKey) return;
			const targetKey: NodeKey = blockKey;

			event.preventDefault();

			const snap = selectionStore.getSnapshot();
			if (!snap.selectedKeys.has(targetKey)) {
				selectionStore.setOnly(targetKey);
			}

			openBlockActionMenu({
				anchor: new DOMRect(event.clientX, event.clientY, 0, 0),
				commands: BLOCK_ACTIONS,
				t,
				onActivate: (command) => {
					const s = selectionStore.getSnapshot();
					const blockKeys = s.selectedKeys.size > 0 ? s.selectedKeys : new Set<NodeKey>([targetKey]);
					command.run({ editor, blockKeys, documentId: noteId });
				},
			});
		}

		root.addEventListener("contextmenu", onContextMenu);
		return () => root.removeEventListener("contextmenu", onContextMenu);
	}, [editor, selectionStore, t, noteId]);

	return null;
}
