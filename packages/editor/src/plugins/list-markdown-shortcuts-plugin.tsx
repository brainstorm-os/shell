/**
 * ListMarkdownShortcutsPlugin — block-level markdown shortcuts INSIDE list
 * items (POLISH-ED-2).
 *
 * `@lexical/markdown`'s shortcut runner only fires when the caret's block is a
 * direct child of the root (`$isRootOrShadowRoot(parentNode.getParent())`), so
 * once `- ` opens a bullet list every further block trigger — `1. `, `[] `,
 * `> `, ` ``` `, `--- ` — types as literal list text. This plugin fills that
 * gap: on the Space that completes a known prefix at the start of a list item,
 * it strips the typed prefix and converts via the same machinery the turn-into
 * menu uses (`$applyTurnInto`), so the result is identical to the sanctioned
 * conversion path.
 *
 * Divider prefixes include the em-dash-mangled forms (`—-` / `——`) for the
 * same reason `HR_TRANSFORMER` does: Notes' `--`→`—` typing shortcut fires on
 * the 2nd hyphen, so a typed `---` arrives mangled before Space lands.
 *
 * Deliberately NOT mounted in the compact editor — it has no turn-into
 * surface, and comments-sized fields keep the smaller vocabulary.
 */

import { $createCodeNode } from "@lexical/code";
import {
	$isListItemNode,
	$isListNode,
	ListItemNode,
	type ListItemNode as ListItemNodeType,
	type ListType,
} from "@lexical/list";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createHorizontalRuleNode } from "@lexical/react/LexicalHorizontalRuleNode";
import { $setBlocksType } from "@lexical/selection";
import { $findMatchingParent, $getNearestNodeOfType } from "@lexical/utils";
import {
	$createParagraphNode,
	$getSelection,
	$isParagraphNode,
	$isRangeSelection,
	$isTextNode,
	COMMAND_PRIORITY_LOW,
	KEY_SPACE_COMMAND,
} from "lexical";
import { useEffect } from "react";
import { BlockType } from "../block-types";
import { $applyTurnInto } from "./turn-into-plugin";

export enum ListShortcutKind {
	List = "list",
	Block = "block",
	Code = "code",
	Divider = "divider",
}

export type ListMarkdownMatch =
	| { kind: ListShortcutKind.List; listType: ListType; checked: boolean }
	| { kind: ListShortcutKind.Block; block: BlockType }
	| { kind: ListShortcutKind.Code; language: string | null }
	| { kind: ListShortcutKind.Divider };

const LIST_TYPE_TO_BLOCK: Readonly<Record<ListType, BlockType>> = {
	bullet: BlockType.BulletList,
	number: BlockType.NumberedList,
	check: BlockType.TodoList,
};

/** Match the text before the caret (the Space is not yet inserted) against the
 *  block-markdown prefixes that convert inside a list item. Pure — unit-tested
 *  directly. */
export function matchListMarkdownPrefix(prefix: string): ListMarkdownMatch | null {
	if (/^\d{1,3}[.)]$/.test(prefix)) {
		return { kind: ListShortcutKind.List, listType: "number", checked: false };
	}
	if (/^[-*+]$/.test(prefix)) {
		return { kind: ListShortcutKind.List, listType: "bullet", checked: false };
	}
	const check = /^\[([ xX]?)\]$/.exec(prefix);
	if (check !== null) {
		return {
			kind: ListShortcutKind.List,
			listType: "check",
			checked: check[1]?.toLowerCase() === "x",
		};
	}
	if (prefix === ">") return { kind: ListShortcutKind.Block, block: BlockType.Quote };
	const heading = /^(#{1,3})$/.exec(prefix);
	if (heading?.[1] !== undefined) {
		const byLevel = [BlockType.Heading1, BlockType.Heading2, BlockType.Heading3] as const;
		const block = byLevel[heading[1].length - 1];
		if (block !== undefined) return { kind: ListShortcutKind.Block, block };
	}
	const code = /^```([A-Za-z0-9+#-]*)$/.exec(prefix);
	if (code !== null) {
		return { kind: ListShortcutKind.Code, language: code[1] ? code[1] : null };
	}
	if (/^(---|\*\*\*|___|—-|——)$/.test(prefix)) return { kind: ListShortcutKind.Divider };
	return null;
}

/** After `$applyTurnInto` to a list type, the selection may sit on the new
 *  ListNode itself (element point) rather than inside its item — resolve the
 *  item either way so `[x] ` can mark it checked. */
function $findConvertedListItem(): ListItemNodeType | null {
	const selection = $getSelection();
	if (!$isRangeSelection(selection)) return null;
	const anchorNode = selection.anchor.getNode();
	const nearest = $getNearestNodeOfType(anchorNode, ListItemNode);
	if (nearest !== null) return nearest;
	if ($isListNode(anchorNode)) {
		const child = anchorNode.getChildAtIndex(selection.anchor.offset) ?? anchorNode.getFirstChild();
		if ($isListItemNode(child)) return child;
	}
	return null;
}

/** Runs inside the `KEY_SPACE_COMMAND` dispatch (an implicit editor update).
 *  Returns true (and eats the Space) only when a conversion happened. */
function $applyListMarkdownShortcut(event: KeyboardEvent): boolean {
	const selection = $getSelection();
	if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
	const anchor = selection.anchor;
	if (anchor.type !== "text") return false;
	const anchorNode = anchor.getNode();
	if (!$isTextNode(anchorNode)) return false;
	const listItem = anchorNode.getParent();
	if (!$isListItemNode(listItem) || listItem.getFirstChild() !== anchorNode) return false;
	const prefix = anchorNode.getTextContent().slice(0, anchor.offset);
	const match = matchListMarkdownPrefix(prefix);
	if (match === null) return false;
	const parentList = listItem.getParent();
	if (!$isListNode(parentList)) return false;
	// Same-type list prefixes stay literal text (typing `- ` in a bullet is
	// intentional content, matching root-level behaviour where `- ` in a bullet
	// never re-triggers).
	if (match.kind === ListShortcutKind.List && parentList.getListType() === match.listType) {
		return false;
	}

	event.preventDefault();
	const parts = anchorNode.splitText(anchor.offset);
	const rest = parts.length > 1 ? parts[1] : null;
	parts[0]?.remove();
	if (rest) rest.selectStart();
	else listItem.selectStart();

	switch (match.kind) {
		case ListShortcutKind.List: {
			const converted = $applyTurnInto(LIST_TYPE_TO_BLOCK[match.listType]);
			if (converted && match.checked) $findConvertedListItem()?.setChecked(true);
			return converted;
		}
		case ListShortcutKind.Block:
			return $applyTurnInto(match.block);
		case ListShortcutKind.Code: {
			const current = $getSelection();
			if (!$isRangeSelection(current)) return false;
			$setBlocksType(current, () =>
				match.language === null ? $createCodeNode() : $createCodeNode(match.language),
			);
			return true;
		}
		case ListShortcutKind.Divider: {
			const current = $getSelection();
			if (!$isRangeSelection(current)) return false;
			$setBlocksType(current, () => $createParagraphNode());
			const after = $getSelection();
			if (!$isRangeSelection(after)) return true;
			const anchorAfter = after.anchor.getNode();
			const paragraph = $isParagraphNode(anchorAfter)
				? anchorAfter
				: $findMatchingParent(anchorAfter, $isParagraphNode);
			paragraph?.insertBefore($createHorizontalRuleNode());
			return true;
		}
	}
}

export function ListMarkdownShortcutsPlugin(): null {
	const [editor] = useLexicalComposerContext();
	useEffect(() => {
		return editor.registerCommand(
			KEY_SPACE_COMMAND,
			(event) => $applyListMarkdownShortcut(event),
			COMMAND_PRIORITY_LOW,
		);
	}, [editor]);
	return null;
}
