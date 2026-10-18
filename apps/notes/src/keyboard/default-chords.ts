/**
 * Default chord bindings for Notes actions. Chord syntax mirrors the
 * shell's registry: `Mod+Shift+K`-style strings, where `Mod` = `Cmd` on
 * macOS, `Ctrl` elsewhere. The trailing token is `KeyboardEvent.key`.
 *
 * Note on letter chords: `KeyboardEvent.key` lowercases when no Shift
 * is held and uppercases with Shift. So `Mod+a` matches Cmd+A; a
 * `Mod+Shift+a` chord would need to be written `Mod+Shift+A`.
 */

import { ActionId } from "./action-ids";

export const DEFAULT_CHORDS: Readonly<Record<ActionId, readonly string[]>> = {
	[ActionId.CancelBlockSelection]: ["Escape"],
	[ActionId.SelectAllOrContainingBlock]: ["Mod+a"],
	[ActionId.WalkBlockUp]: ["ArrowUp"],
	[ActionId.WalkBlockDown]: ["ArrowDown"],
	[ActionId.ExtendBlockUp]: ["Shift+ArrowUp"],
	[ActionId.ExtendBlockDown]: ["Shift+ArrowDown"],
	[ActionId.JumpToFirstBlock]: ["Mod+ArrowUp"],
	[ActionId.JumpToLastBlock]: ["Mod+ArrowDown"],
	[ActionId.DeleteSelectedBlocks]: ["Backspace", "Delete"],
	[ActionId.ToggleSidebar]: ["Mod+\\"],
	[ActionId.ToggleProperties]: ["Mod+Shift+\\"],
	[ActionId.ToggleNoteLock]: ["Mod+Alt+l"],
	[ActionId.CloseIconPicker]: ["Escape"],
	[ActionId.CloseActionMenu]: ["Escape"],
	[ActionId.CloseColorMenu]: ["Escape"],
	[ActionId.CloseInlineOverflow]: ["Escape"],
	[ActionId.OpenEmojiPicker]: ["Mod+e"],
	[ActionId.OpenColorMenu]: ["Mod+Shift+C", "Mod+Shift+H"],
	[ActionId.CloseEmbedChooser]: ["Escape"],
	[ActionId.CommitInlineEdit]: ["Enter"],
	[ActionId.CancelInlineEdit]: ["Escape"],
	[ActionId.PickerHighlightPrev]: ["ArrowUp"],
	[ActionId.PickerHighlightNext]: ["ArrowDown"],
	[ActionId.MoveSelectedBlocksUp]: ["Mod+Shift+ArrowUp"],
	[ActionId.MoveSelectedBlocksDown]: ["Mod+Shift+ArrowDown"],
	[ActionId.DuplicateSelectedBlocks]: ["Mod+d"],
	[ActionId.CopySelectedBlocks]: ["Mod+c"],
	[ActionId.CutSelectedBlocks]: ["Mod+x"],
	[ActionId.PasteSelectedBlocks]: ["Mod+v"],
	[ActionId.ExitCodeBlock]: ["Mod+Enter"],
	[ActionId.OpenInsertMenu]: ["Mod+Shift+Enter"],
	[ActionId.CloseMediaInspector]: ["Escape"],
	[ActionId.OpenLinkMarkup]: ["Mod+k"],
	[ActionId.ToggleStrikeMark]: ["Mod+Shift+S"],
	[ActionId.ToggleCodeMark]: ["Mod+Shift+E"],
	[ActionId.OpenMentionPicker]: ["Mod+Shift+M"],
	[ActionId.TurnIntoParagraph]: ["Mod+Alt+0"],
	[ActionId.TurnIntoHeading1]: ["Mod+Alt+1"],
	[ActionId.TurnIntoHeading2]: ["Mod+Alt+2"],
	[ActionId.TurnIntoHeading3]: ["Mod+Alt+3"],
	[ActionId.TurnIntoBulletList]: ["Mod+Alt+4"],
	[ActionId.TurnIntoNumberedList]: ["Mod+Alt+5"],
	[ActionId.TurnIntoTodoList]: ["Mod+Alt+6"],
	[ActionId.TurnIntoQuote]: ["Mod+Alt+7"],
	[ActionId.TurnIntoCode]: ["Mod+Alt+8"],
	[ActionId.TurnIntoCallout]: ["Mod+Alt+9"],
	[ActionId.DictionaryReorderToggle]: [" "],
	[ActionId.DictionaryReorderUp]: ["ArrowUp"],
	[ActionId.DictionaryReorderDown]: ["ArrowDown"],
	[ActionId.DictionaryFocusSearch]: ["Mod+f"],
	[ActionId.CloseDictionaryEditor]: ["Escape"],
	// Cmd/Ctrl+F belongs to in-document find (the shared `find-replace`
	// primitive, doc 59) — it's mounted in every note editor. Notes-list
	// search ("find across my notes") takes Mod+Shift+F, the VS Code / Notion
	// convention, so the in-doc find bar is reachable on its canonical chord
	// instead of being shadowed by the list filter (F-033).
	[ActionId.FocusNotesSearch]: ["Mod+Shift+F"],
	[ActionId.ClearNotesSearch]: ["Escape"],
	// Cmd/Ctrl+P prints (= PDF export, B11.6 → B11.12). The capture-phase
	// listener preventDefaults so Chromium's print dialog never opens.
	[ActionId.PrintNote]: ["Mod+p"],
	[ActionId.AcceptBookmarkSuggestion]: ["Enter"],
	[ActionId.DismissBookmarkSuggestion]: ["Escape"],
};
