/**
 * FormatChordsPlugin — keyboard chords for the text marks Lexical ships no
 * default binding for (B11.6). Bold / Italic / Underline already have native
 * `Mod+B/I/U`; this adds strikethrough (`Mod+Shift+S`) and inline code
 * (`Mod+l`), routed through the Notes shortcut registry (never raw `e.key`,
 * per the keyboard convention) so they're rebindable alongside every other
 * chord. Each just toggles `FORMAT_TEXT_COMMAND`, the same command the inline
 * toolbar's buttons dispatch — so the chord and the button stay in lockstep.
 *
 * Bulk path (B11.7): block-selection mode has no Lexical caret (the root is
 * blurred), so a bare mark / turn-into chord would no-op. When blocks are
 * selected we first bridge them to a range selection spanning the set — the
 * same `selectBlocksAsRange` the gutter action menu uses — so a single chord
 * strikes / turns-into every selected block at once.
 *
 * Nested editors ("Edit here", B11.22): the host skips a keystroke that comes
 * from an editor nested inside it (`isEventInNestedEditor`) — otherwise
 * Mod+Alt+1 typed in the transcluded body would turn the HOST's last-caret
 * block into a heading. The nested body mounts its own instance with
 * `nested`, which only answers keystrokes from inside its own root (or while
 * its own blocks are selected), so each chord reaches exactly one editor.
 */

import {
	BlockType,
	TURN_INTO_COMMAND,
	formatTextInBlocks,
	isEventInNestedEditor,
	useBlockSelectionStore,
} from "@brainstorm-os/editor";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { FORMAT_TEXT_COMMAND, type TextFormatType } from "lexical";
import { useCallback, useEffect } from "react";
import { ActionId } from "../keyboard/action-ids";
import { matchesActionChord, useShortcut } from "../keyboard/use-shortcut";
import { selectBlocksAsRange } from "./commands";

// `Mod+Alt+0…9` → turn the current block into the matching style. The chord
// matcher resolves Alt+digit via `event.code` (Option-modified `event.key`).
const TURN_INTO_CHORDS: ReadonlyArray<[ActionId, BlockType]> = [
	[ActionId.TurnIntoParagraph, BlockType.Paragraph],
	[ActionId.TurnIntoHeading1, BlockType.Heading1],
	[ActionId.TurnIntoHeading2, BlockType.Heading2],
	[ActionId.TurnIntoHeading3, BlockType.Heading3],
	[ActionId.TurnIntoBulletList, BlockType.BulletList],
	[ActionId.TurnIntoNumberedList, BlockType.NumberedList],
	[ActionId.TurnIntoTodoList, BlockType.TodoList],
	[ActionId.TurnIntoQuote, BlockType.Quote],
	[ActionId.TurnIntoCode, BlockType.Code],
	[ActionId.TurnIntoCallout, BlockType.Callout],
];

export function FormatChordsPlugin({ nested = false }: { nested?: boolean } = {}): null {
	const [editor] = useLexicalComposerContext();
	const blockSelection = useBlockSelectionStore();

	const ownsEvent = useCallback(
		(event: KeyboardEvent): boolean => {
			const root = editor.getRootElement();
			if (isEventInNestedEditor(event, root)) return false;
			if (!nested) return true;
			const target = event.target;
			const insideRoot = root !== null && target instanceof Node && root.contains(target);
			return insideRoot || blockSelection.getSnapshot().selectedKeys.size > 0;
		},
		[editor, blockSelection, nested],
	);

	// In block-selection mode there's no Lexical caret, so a mark applies to
	// every text node in the selected blocks (a bridged element-boundary range
	// can't be formatted point-to-point). Otherwise the chord keeps its
	// caret/text-selection behaviour via `FORMAT_TEXT_COMMAND`.
	const applyMark = useCallback(
		(format: TextFormatType): void => {
			const keys = blockSelection.getSnapshot().selectedKeys;
			if (keys.size > 0) formatTextInBlocks(editor, keys, format);
			else editor.dispatchCommand(FORMAT_TEXT_COMMAND, format);
		},
		[editor, blockSelection],
	);

	// Turn-into transforms whole blocks, so it bridges the block selection to a
	// range first (`$setBlocksType` reads the range) — same path the gutter
	// action menu uses. No-op bridge when nothing is block-selected.
	const bridgeBlockSelection = useCallback((): void => {
		const keys = blockSelection.getSnapshot().selectedKeys;
		if (keys.size === 0) return;
		editor.update(() => selectBlocksAsRange(keys));
	}, [editor, blockSelection]);

	useShortcut(
		ActionId.ToggleStrikeMark,
		useCallback(
			(event: KeyboardEvent) => {
				if (!ownsEvent(event)) return;
				event.preventDefault();
				applyMark("strikethrough");
			},
			[applyMark, ownsEvent],
		),
	);

	useShortcut(
		ActionId.ToggleCodeMark,
		useCallback(
			(event: KeyboardEvent) => {
				if (!ownsEvent(event)) return;
				event.preventDefault();
				applyMark("code");
			},
			[applyMark, ownsEvent],
		),
	);

	// One document-capture listener for all ten turn-into quick chords (a
	// `useShortcut` per chord would be ten listeners for one concern).
	useEffect(() => {
		function onKeydown(event: KeyboardEvent) {
			if (!ownsEvent(event)) return;
			for (const [id, blockType] of TURN_INTO_CHORDS) {
				if (matchesActionChord(id, event)) {
					event.preventDefault();
					bridgeBlockSelection();
					editor.dispatchCommand(TURN_INTO_COMMAND, blockType);
					return;
				}
			}
		}
		// this IS the registry attach point — chords resolve via
		// matchesActionChord(id, event), not raw key comparison.
		// keyboard-exempt
		document.addEventListener("keydown", onKeydown, true);
		return () => document.removeEventListener("keydown", onKeydown, true);
	}, [editor, bridgeBlockSelection, ownsEvent]);

	return null;
}
