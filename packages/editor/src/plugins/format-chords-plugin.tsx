/**
 * FormatChordsPlugin — keyboard chords for the editing actions Lexical ships no
 * default binding for, shared by every editor consumer (extracted from Notes).
 *
 *   - Strikethrough `Mod+Shift+S` and inline code `Mod+E` (with `Mod+Shift+E`
 *     kept as an alias) — the two marks with no native chord (Bold / Italic /
 *     Underline already have `Mod+B/I/U`). `Mod+E` is the convention users
 *     arrive with (Notion et al.) — POLISH-ED-3 filed exactly this gap.
 *     Each toggles `FORMAT_TEXT_COMMAND`, the same command the inline toolbar's
 *     buttons dispatch, so chord and button stay in lockstep.
 *   - Turn-into `Mod+Alt+0…9` — paragraph / H1-3 / bullet / numbered / todo /
 *     quote / code / callout. These match the physical digit via `event.code`
 *     (NOT `event.key`): on macOS `Option+0` is a dead key whose `event.key` is
 *     a glyph (`º`), not `"0"` — so the shared `matchesChord` (which keys off
 *     `event.key`) can't see them. Hence a self-contained capture listener.
 *
 * Bulk path: block-selection mode has no Lexical caret (the root is blurred), so
 * a bare mark / turn-into chord would no-op. When blocks are selected we bridge
 * them to a range first (`selectBlocksAsRange`, the same path the gutter action
 * menu uses) — or, for marks, format every text node in the set
 * (`formatTextInBlocks`) — so one chord strikes / turns-into every selected
 * block at once.
 */

import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { FORMAT_TEXT_COMMAND, type TextFormatType } from "lexical";
import { useCallback, useEffect } from "react";
import { BlockType } from "../block-types";
import { selectBlocksAsRange } from "../standard-commands";
import { formatTextInBlocks } from "./block-ops";
import { useBlockSelectionStore } from "./block-selection-plugin";
import { useEditorShortcut } from "./editor-shortcut";
import { TURN_INTO_COMMAND } from "./turn-into-plugin";

// `Mod+Alt+<digit>` → turn the current/selected block(s) into the matching
// style. Indexed by the digit so the `event.code` (`Digit<n>`) maps directly.
const TURN_INTO_BY_DIGIT: ReadonlyArray<BlockType> = [
	BlockType.Paragraph, // 0
	BlockType.Heading1, // 1
	BlockType.Heading2, // 2
	BlockType.Heading3, // 3
	BlockType.BulletList, // 4
	BlockType.NumberedList, // 5
	BlockType.TodoList, // 6
	BlockType.Quote, // 7
	BlockType.Code, // 8
	BlockType.Callout, // 9
];

export function FormatChordsPlugin(): null {
	const [editor] = useLexicalComposerContext();
	const blockSelection = useBlockSelectionStore();

	// In block-selection mode there's no Lexical caret, so a mark applies to
	// every text node in the selected blocks. Otherwise the chord keeps its
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

	useEditorShortcut(
		["Mod+Shift+S"],
		useCallback(
			(event: KeyboardEvent) => {
				event.preventDefault();
				applyMark("strikethrough");
			},
			[applyMark],
		),
	);

	useEditorShortcut(
		["Mod+E", "Mod+Shift+E"],
		useCallback(
			(event: KeyboardEvent) => {
				event.preventDefault();
				applyMark("code");
			},
			[applyMark],
		),
	);

	// The ten turn-into quick chords share one capture listener — matched by
	// `event.code` so the macOS Option-dead-key doesn't hide the digit.
	useEffect(() => {
		function onKeydown(event: KeyboardEvent) {
			if (!(event.metaKey || event.ctrlKey) || !event.altKey || event.shiftKey) return;
			const match = /^Digit([0-9])$/.exec(event.code);
			if (match === null) return;
			const blockType = TURN_INTO_BY_DIGIT[Number(match[1])];
			if (blockType === undefined) return;
			event.preventDefault();
			bridgeBlockSelection();
			editor.dispatchCommand(TURN_INTO_COMMAND, blockType);
		}
		// Physical-digit (`event.code`) matcher for the Option-dead-key chords —
		// the registry attach point, not a raw single-key handler.
		// keyboard-exempt
		document.addEventListener("keydown", onKeydown, true);
		return () => document.removeEventListener("keydown", onKeydown, true);
	}, [editor, bridgeBlockSelection]);

	return null;
}
