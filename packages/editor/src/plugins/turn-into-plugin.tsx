/**
 * TurnIntoPlugin — handles `TURN_INTO_COMMAND`. Replaces the focused
 * top-level node with the requested type, preserving inline text/format
 * where possible (paragraph ↔ heading ↔ quote keep their children;
 * list-wrapping or code-converting builds a fresh container).
 *
 * Follows the conventional `TurnIntoPlugin` shape in Lexical block
 * editors, but the payload is a TS enum (BlockType), not a string
 * literal — per CLAUDE.md.
 */

import { $createCodeNode } from "@lexical/code";
import { $createListItemNode, $createListNode, type ListType } from "@lexical/list";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $createHeadingNode, $createQuoteNode, type HeadingTagType } from "@lexical/rich-text";
import { $setBlocksType } from "@lexical/selection";
import {
	$createParagraphNode,
	$getSelection,
	$isRangeSelection,
	COMMAND_PRIORITY_EDITOR,
	createCommand,
} from "lexical";
import { useEffect } from "react";
import { BlockType } from "../block-types";
import { $createCalloutNode } from "../nodes/callout-node";

export const TURN_INTO_COMMAND = createCommand<BlockType>("TURN_INTO_COMMAND");

/** Apply a turn-into on the current range selection. Exposed so other
 *  plugins (list markdown shortcuts) can convert inside their own update
 *  without a nested command dispatch. Must run inside `editor.update`. */
export function $applyTurnInto(target: BlockType): boolean {
	const selection = $getSelection();
	if (!$isRangeSelection(selection)) return false;
	switch (target) {
		case BlockType.Paragraph:
			$setBlocksType(selection, () => $createParagraphNode());
			return true;
		case BlockType.Heading1:
		case BlockType.Heading2:
		case BlockType.Heading3: {
			const tag: HeadingTagType =
				target === BlockType.Heading1 ? "h1" : target === BlockType.Heading2 ? "h2" : "h3";
			$setBlocksType(selection, () => $createHeadingNode(tag));
			return true;
		}
		case BlockType.Quote:
			$setBlocksType(selection, () => $createQuoteNode());
			return true;
		case BlockType.BulletList:
		case BlockType.NumberedList:
		case BlockType.TodoList: {
			const listType: ListType =
				target === BlockType.BulletList
					? "bullet"
					: target === BlockType.NumberedList
						? "number"
						: "check";
			$setBlocksType(selection, () => {
				const list = $createListNode(listType);
				// `$createListItemNode(checked?)` takes the *checked* flag — a fresh
				// to-do must start unchecked, not pre-completed.
				list.append($createListItemNode(listType === "check" ? false : undefined));
				return list;
			});
			return true;
		}
		case BlockType.Code:
			$setBlocksType(selection, () => $createCodeNode());
			return true;
		case BlockType.Callout:
			$setBlocksType(selection, () => $createCalloutNode());
			return true;
	}
	return false;
}

export function TurnIntoPlugin() {
	const [editor] = useLexicalComposerContext();
	useEffect(() => {
		return editor.registerCommand(TURN_INTO_COMMAND, $applyTurnInto, COMMAND_PRIORITY_EDITOR);
	}, [editor]);
	return null;
}
