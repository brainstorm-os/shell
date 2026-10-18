/**
 * Action ids for keyboard chords inside the Notes app.
 *
 * Mirrors the shell's `renderer/shortcuts/default-chords.ts` pattern:
 * every chord routes through an action id, no raw `e.key` checks (per
 * CLAUDE.md §Keyboard). Apps don't yet have access to the shell's
 * shortcut registry, so we run a per-app one — when the SDK grows a
 * `ui.shortcuts` surface this map lifts upward without touching call
 * sites.
 */

export enum ActionId {
	CancelBlockSelection = "notes.cancel-block-selection",
	SelectAllOrContainingBlock = "notes.select-all-or-containing-block",
	WalkBlockUp = "notes.walk-block-up",
	WalkBlockDown = "notes.walk-block-down",
	ExtendBlockUp = "notes.extend-block-up",
	ExtendBlockDown = "notes.extend-block-down",
	JumpToFirstBlock = "notes.jump-to-first-block",
	JumpToLastBlock = "notes.jump-to-last-block",
	DeleteSelectedBlocks = "notes.delete-selected-blocks",
	ToggleSidebar = "notes.toggle-sidebar",
	/** Show/hide the right-hand Properties panel. Bound to `Mod+Shift+\`. */
	ToggleProperties = "notes.toggle-properties",
	/** Lock/unlock the open note (page-level read-only). Bound to `Mod+Alt+l`
	 *  (OQ-235 (a): `Mod+Shift+L` stays on the shell appearance toggle). */
	ToggleNoteLock = "notes.toggle-note-lock",
	CloseIconPicker = "notes.close-icon-picker",
	CloseActionMenu = "notes.close-action-menu",
	CloseColorMenu = "notes.close-color-menu",
	CloseInlineOverflow = "notes.close-inline-overflow",
	/** Open the emoji `:`-picker at the caret. Bound to `Mod+e`. */
	OpenEmojiPicker = "notes.open-emoji-picker",
	/** Open the inline text/highlight colour menu for the current selection.
	 *  Bound to `Mod+Shift+C` (text) / `Mod+Shift+H` (highlight) — both open
	 *  the combined menu. */
	OpenColorMenu = "notes.open-color-menu",
	CloseEmbedChooser = "notes.close-embed-chooser",
	/** Commit an inline form-control edit (cell input, future popover
	 *  fields). Bound to `Enter`. Element-scoped — fires only when the
	 *  input owning the chord is focused. */
	CommitInlineEdit = "notes.commit-inline-edit",
	/** Revert an inline edit. Bound to `Escape`. Element-scoped. */
	CancelInlineEdit = "notes.cancel-inline-edit",
	/** Move the highlight up in the property picker list. Bound to
	 *  `ArrowUp`. Element-scoped to the picker's search input. */
	PickerHighlightPrev = "notes.picker-highlight-prev",
	/** Move the highlight down in the property picker list. Bound to
	 *  `ArrowDown`. Element-scoped to the picker's search input. */
	PickerHighlightNext = "notes.picker-highlight-next",
	MoveSelectedBlocksUp = "notes.move-selected-blocks-up",
	MoveSelectedBlocksDown = "notes.move-selected-blocks-down",
	DuplicateSelectedBlocks = "notes.duplicate-selected-blocks",
	CopySelectedBlocks = "notes.copy-selected-blocks",
	CutSelectedBlocks = "notes.cut-selected-blocks",
	PasteSelectedBlocks = "notes.paste-selected-blocks",
	/** Exit a code block by inserting a fresh paragraph after it. Bound to
	 *  `Mod+Enter` — conventional escape hatch when Enter alone inserts a
	 *  newline inside the code. */
	ExitCodeBlock = "notes.exit-code-block",
	/** Open the block Insert menu below the caret's block (B11.21). Bound to
	 *  `Mod+Shift+Enter`; the editor's `INSERT_MENU_CHORDS` owns the binding. */
	OpenInsertMenu = "notes.open-insert-menu",
	/** Close the media inspector popover. Bound to `Escape`. */
	CloseMediaInspector = "notes.close-media-inspector",
	/** Toggle the strikethrough text mark on the selection (B11.6). Lexical
	 *  has no default chord for strike. Bound to `Mod+Shift+S`. */
	ToggleStrikeMark = "notes.toggle-strike-mark",
	/** Toggle the inline-code text mark on the selection (B11.6). Bound to
	 *  `Mod+Shift+E` — `Mod+e` (the Notion / GitHub inline-code convention)
	 *  was reassigned to the emoji picker by user request, so code shifts to
	 *  `Mod+Shift+E`. The plan tentatively suggested `Mod+l`, but Chromium
	 *  reserves Cmd/Ctrl+L for the omnibox so the keydown never reaches the
	 *  renderer. */
	ToggleCodeMark = "notes.toggle-code-mark",
	/** Open the `@`-mention picker at the caret (B11.6) — inserts the `@`
	 *  trigger (prefixing a space when mid-word so the typeahead opens).
	 *  Bound to `Mod+Shift+M`, additive to typing `@`. */
	OpenMentionPicker = "notes.open-mention-picker",
	/** Turn-into quick chords (B11.6) — `Mod+Alt+0…9` convert the current
	 *  block to the matching style. (Alt+digit matches via `event.code`; see
	 *  the chord matcher.) */
	TurnIntoParagraph = "notes.turn-into-paragraph",
	TurnIntoHeading1 = "notes.turn-into-heading-1",
	TurnIntoHeading2 = "notes.turn-into-heading-2",
	TurnIntoHeading3 = "notes.turn-into-heading-3",
	TurnIntoBulletList = "notes.turn-into-bullet-list",
	TurnIntoNumberedList = "notes.turn-into-numbered-list",
	TurnIntoTodoList = "notes.turn-into-todo-list",
	TurnIntoQuote = "notes.turn-into-quote",
	TurnIntoCode = "notes.turn-into-code",
	TurnIntoCallout = "notes.turn-into-callout",
	/** Open the link-markup picker — wraps the current non-empty selection
	 *  in a `brainstorm://entity/<id>` LinkNode after the user picks an
	 *  entity. Bound to `Mod+k`. */
	OpenLinkMarkup = "notes.open-link-markup",
	/** Toggle keyboard-reorder pickup/drop on a dictionary item row.
	 *  Bound to `Space`. Element-scoped to the row's drag handle. */
	DictionaryReorderToggle = "notes.dictionary-reorder-toggle",
	/** Move a picked-up dictionary row up. Bound to `ArrowUp`.
	 *  Element-scoped to the drag handle while in pickup mode. */
	DictionaryReorderUp = "notes.dictionary-reorder-up",
	/** Move a picked-up dictionary row down. Bound to `ArrowDown`. */
	DictionaryReorderDown = "notes.dictionary-reorder-down",
	/** Focus the dictionary editor's search input. Bound to `Mod+f`. */
	DictionaryFocusSearch = "notes.dictionary-focus-search",
	/** Close the dictionary editor overlay. Bound to `Escape`. */
	CloseDictionaryEditor = "notes.close-dictionary-editor",
	/** Focus the notes-list inline search input ("search across notes").
	 *  Bound to `Mod+Shift+f` — `Mod+f` is in-document find (the shared
	 *  find-replace primitive mounted in the editor). */
	FocusNotesSearch = "notes.focus-notes-search",
	/** Clear + blur the notes-list search. Bound to `Escape`.
	 *  Element-scoped to the search input. */
	ClearNotesSearch = "notes.clear-notes-search",
	/** Print the open note. Bound to `Mod+p`; routes to PDF export (the
	 *  document's print artifact, B11.6 → B11.12). preventDefault suppresses
	 *  Chromium's own print dialog. */
	PrintNote = "notes.print-note",
	/** Accept the paste-URL → bookmark-card suggestion (9.18.2b): replace the
	 *  freshly-pasted link with an embedded bookmark block. Bound to `Enter`.
	 *  Element-scoped to the suggestion affordance's accept button. */
	AcceptBookmarkSuggestion = "notes.accept-bookmark-suggestion",
	/** Dismiss the paste-URL → bookmark-card suggestion, leaving the plain
	 *  link. Bound to `Escape`. Element-scoped to the suggestion affordance. */
	DismissBookmarkSuggestion = "notes.dismiss-bookmark-suggestion",
}
