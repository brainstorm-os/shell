/**
 * TablesPlugin — registers Lexical's first-party table behaviour
 * (`<TablePlugin>`: INSERT_TABLE_COMMAND handling, tab-cell navigation,
 * cell merge, multi-cell selection) and layers a single contextual trigger
 * that floats at the top-left of the table the caret is in. Clicking it
 * opens the shared fancy-menu of table actions (`openTableMenu`) — the menu
 * is NOT shown on cell focus, only on an explicit click.
 *
 * The trigger follows the same shape as the inline toolbar (a React subtree
 * inside the plugin tree, `position: fixed`, viewport-relative) so
 * positioning, theming and dismissal stay consistent. Structural mutations
 * route through `table-ops.ts` so the unstable underscore API lives in
 * exactly one place.
 */

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { TablePlugin } from "@lexical/react/LexicalTablePlugin";
import { $getTableCellNodeFromLexicalNode, $isTableNode } from "@lexical/table";
import { mergeRegister } from "@lexical/utils";
import {
	$getSelection,
	$isRangeSelection,
	COMMAND_PRIORITY_LOW,
	SELECTION_CHANGE_COMMAND,
} from "lexical";
import { useCallback, useEffect, useRef, useState } from "react";
import { useEditorT } from "../i18n";
import { GripIcon } from "../icons";
import { useEditorShortcut } from "./editor-shortcut";
import { openTableMenu } from "./table-menu";
import { fillDownColumn, selectionInTable } from "./table-ops";

/** Fill the selected cell's value down its column — only fires when the
 *  caret is inside a table (guarded in the handler). */
const FILL_DOWN_CHORDS = ["Mod+Shift+D"] as const;

type TableToolbarState = { rect: DOMRect };

export function TablesPlugin() {
	const [editor] = useLexicalComposerContext();
	const [state, setState] = useState<TableToolbarState | null>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const t = useEditorT();

	useEffect(() => {
		function read(): TableToolbarState | null {
			let next: TableToolbarState | null = null;
			editor.getEditorState().read(() => {
				const selection = $getSelection();
				if (!$isRangeSelection(selection)) return;
				const cell = $getTableCellNodeFromLexicalNode(selection.anchor.getNode());
				const table = cell?.getParent()?.getParent();
				if (!table || !$isTableNode(table)) return;
				const el = editor.getElementByKey(table.getKey());
				if (!el) return;
				next = { rect: el.getBoundingClientRect() };
			});
			return next;
		}
		function apply() {
			setState(read());
		}
		// The trigger is `position: fixed` (viewport coords), but the table moves
		// under it on scroll/resize. Without re-reading the table rect on those
		// events the button strands at a stale screen position, detached from the
		// table — it looks "hung" in a fixed spot. Capture-phase scroll so an
		// ANCESTOR scroll container (the editor's own scroll pane, not just the
		// window) re-tracks it too. Mirrors the inline-toolbar reflow.
		const onScrollOrResize = () => apply();
		document.addEventListener("scroll", onScrollOrResize, true);
		window.addEventListener("resize", onScrollOrResize);
		const unregister = mergeRegister(
			editor.registerUpdateListener(apply),
			editor.registerCommand(
				SELECTION_CHANGE_COMMAND,
				() => {
					apply();
					return false;
				},
				COMMAND_PRIORITY_LOW,
			),
		);
		return () => {
			unregister();
			document.removeEventListener("scroll", onScrollOrResize, true);
			window.removeEventListener("resize", onScrollOrResize);
		};
	}, [editor]);

	useEditorShortcut(
		FILL_DOWN_CHORDS,
		useCallback(
			(event: KeyboardEvent) => {
				let inTable = false;
				editor.getEditorState().read(() => {
					inTable = selectionInTable();
				});
				if (!inTable) return;
				event.preventDefault();
				fillDownColumn(editor);
			},
			[editor],
		),
	);

	return (
		<>
			<TablePlugin hasCellMerge hasCellBackgroundColor />
			{state && (
				<button
					ref={triggerRef}
					type="button"
					className="bs-editor__table-trigger"
					title={t("editor.table.open")}
					aria-label={t("editor.table.open")}
					aria-haspopup="menu"
					style={{
						top: `${Math.max(8, state.rect.top - 32)}px`,
						left: `${state.rect.left}px`,
					}}
					onMouseDown={(event) => event.preventDefault()}
					onClick={() => {
						if (triggerRef.current) openTableMenu({ anchor: triggerRef.current, editor, t });
					}}
				>
					{GripIcon()}
				</button>
			)}
		</>
	);
}
