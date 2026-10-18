/**
 * The block Insert menu (B11.21) — the gutter `+`, the block action menu's
 * "Insert above / below…" rows and the `Mod+Shift+Enter` chord all open the
 * SAME slash catalogue as a filterable picker through the shared search
 * picker (`@brainstorm-os/sdk/menus`), and the chosen command runs against a
 * fresh paragraph placed next to the target block.
 *
 * The paragraph is only created once a command is chosen: dismissing the
 * picker leaves the document untouched (no stray empty block to clean up).
 * Every slash command is written to act on "the caret's empty paragraph"
 * (that is what the slash menu hands it after clearing `/query`), so placing
 * the caret in a new empty paragraph and running the command reuses the
 * catalogue verbatim — no insert-specific variant per block type.
 */

import { type SearchPickerItem, openSearchPicker } from "@brainstorm-os/sdk/menus";
import { $isListItemNode } from "@lexical/list";
import {
	$createParagraphNode,
	$getNodeByKey,
	$getRoot,
	type LexicalEditor,
	type NodeKey,
} from "lexical";
import { type BlockCommand, CommandCategory } from "../block-command";
import type { EditorT } from "../i18n";
import { InsertAboveIcon, InsertBelowIcon } from "../icons";
import { buildSlashMenuView } from "../slash-sections";
import { getAllBlocks } from "../top-level-block";

export enum InsertPosition {
	Above = "above",
	Below = "below",
}

/** Opens the insert picker below the caret's (or the last selected) block. */
export const INSERT_MENU_CHORDS: readonly string[] = ["Mod+Shift+Enter"];

const EMPTY_ROW_ID = "insert:empty";

/** Rows for the picker: browse order (slash sections) for an empty query,
 *  relevance-ranked otherwise; a single disabled row when nothing matches. */
export function insertMenuRows(
	commands: readonly BlockCommand[],
	query: string,
	emptyLabel: string,
): readonly SearchPickerItem[] {
	const matches = buildSlashMenuView(commands, query).commands;
	if (matches.length === 0) return [{ id: EMPTY_ROW_ID, label: emptyLabel, disabled: true }];
	return matches.map((command) => ({
		id: command.id,
		label: command.label,
		icon: command.icon,
		...(command.description ? { caption: command.description } : {}),
	}));
}

/** Insert an empty paragraph next to `blockKey` and park the caret in it.
 *  Returns the new paragraph's key, or `null` when the block is gone. */
export function insertEmptyBlock(
	editor: LexicalEditor,
	blockKey: NodeKey,
	position: InsertPosition,
): NodeKey | null {
	let inserted: NodeKey | null = null;
	editor.update(
		() => {
			const node = $getNodeByKey(blockKey);
			if (!node) return;
			const paragraph = $createParagraphNode();
			if (position === InsertPosition.Below) {
				node.insertAfter(paragraph);
			} else if ($isListItemNode(node)) {
				// A paragraph can't sit inside a list: above the first item goes
				// before the whole list, otherwise it splits the list at the item
				// above (`ListItemNode.insertAfter` does the split).
				const previous = node.getPreviousSibling();
				if (previous) previous.insertAfter(paragraph);
				else node.getParentOrThrow().insertBefore(paragraph);
			} else {
				node.insertBefore(paragraph);
			}
			paragraph.selectStart();
			inserted = paragraph.getKey();
		},
		{ discrete: true },
	);
	return inserted;
}

/** Insert a paragraph next to `blockKey`, then run `command` against it as a
 *  fresh top-level update (the same deferral the slash menu uses, so the
 *  command reads a settled selection). */
export function insertBlockWithCommand(
	editor: LexicalEditor,
	blockKey: NodeKey,
	position: InsertPosition,
	command: BlockCommand,
	documentId?: string,
): boolean {
	if (insertEmptyBlock(editor, blockKey, position) === null) return false;
	editor.getRootElement()?.focus({ preventScroll: true });
	queueMicrotask(() => {
		void Promise.resolve(command.run({ editor, ...(documentId ? { documentId } : {}) })).catch(
			() => undefined,
		);
	});
	return true;
}

export type OpenInsertMenuOptions = {
	editor: LexicalEditor;
	blockKey: NodeKey;
	position: InsertPosition;
	commands: readonly BlockCommand[];
	t: EditorT;
	/** The trigger the picker drops from (tracks + flips off its live rect). */
	anchor?: Element;
	/** A viewport rect for a trigger-less open (action-menu row, chord). */
	rect?: DOMRect;
	documentId?: string;
	onClose?: () => void;
};

/** Open the insert picker. Without a mounted menu host it degrades to the
 *  pre-B11.21 behaviour — a plain empty paragraph — so `+` is never dead. */
export function openInsertMenu(options: OpenInsertMenuOptions): boolean {
	const { editor, blockKey, position, commands, t, anchor, rect, documentId, onClose } = options;
	const emptyLabel = t("editor.insertMenu.empty");
	const opened = openSearchPicker({
		placeholder: t("editor.insertMenu.placeholder"),
		ariaLabel: t("editor.insertMenu.region"),
		filter: (query) => insertMenuRows(commands, query, emptyLabel),
		onSelect: (id) => {
			const command = commands.find((c) => c.id === id);
			if (!command) return;
			// After the picker has closed and handed focus back.
			setTimeout(() => insertBlockWithCommand(editor, blockKey, position, command, documentId), 0);
		},
		...(onClose ? { onClose } : {}),
		...(rect ? { rect } : anchor ? { anchor } : {}),
	});
	if (!opened) {
		insertEmptyBlock(editor, blockKey, position);
		onClose?.();
	}
	return opened;
}

/** The target block for an insert relative to a block set: the first block
 *  (document order) for Above, the last for Below. */
export function pickInsertTarget(
	editor: LexicalEditor,
	keys: ReadonlySet<NodeKey>,
	position: InsertPosition,
): NodeKey | null {
	let target: NodeKey | null = null;
	editor.getEditorState().read(() => {
		const ordered = getAllBlocks($getRoot())
			.map((block) => block.getKey())
			.filter((key) => keys.has(key));
		const first = keys.values().next();
		const fallback = first.done ? null : first.value;
		target =
			(position === InsertPosition.Above ? ordered[0] : ordered[ordered.length - 1]) ?? fallback;
	});
	return target;
}

/** "Insert above… / Insert below…" rows for the block action menu, opening
 *  the insert picker over `catalogue` next to the targeted block(s). */
export function createInsertBlockActions(
	t: EditorT,
	catalogue: readonly BlockCommand[],
): readonly BlockCommand[] {
	const action = (position: InsertPosition): BlockCommand => ({
		id: `block.insert.${position}`,
		category: CommandCategory.Insert,
		label: t(position === InsertPosition.Above ? "editor.insert.above" : "editor.insert.below"),
		icon: position === InsertPosition.Above ? <InsertAboveIcon /> : <InsertBelowIcon />,
		keywords: ["insert", "add", "new", "block", position],
		run: ({ editor, blockKeys, documentId }) => {
			if (!blockKeys || blockKeys.size === 0) return;
			const blockKey = pickInsertTarget(editor, blockKeys, position);
			if (!blockKey) return;
			const rect = editor.getElementByKey(blockKey)?.getBoundingClientRect();
			// The action menu is still closing; open on the next task so the two
			// menus don't fight over the runtime's stack / focus restore.
			setTimeout(() => {
				openInsertMenu({
					editor,
					blockKey,
					position,
					commands: catalogue,
					t,
					...(rect ? { rect } : {}),
					...(documentId ? { documentId } : {}),
				});
			}, 0);
		},
	});
	return [action(InsertPosition.Above), action(InsertPosition.Below)];
}
