/**
 * Declared keyboard surface for the Code-Editor renderer. The Code-Editor
 * had NO keyboard path before this — every binding routes through
 * `@brainstorm-os/sdk/shortcut` `attachShortcut` (no raw `e.key`, per
 *  §Keyboard handling). Chord
 * syntax is the shared shell registry syntax.
 *
 * Save is wired but inert in this preview drop: write-through to the
 * entities service is the deferred 9.7.2 rung. The chord is declared now
 * so the affordance + the keyboard path exist; the handler becomes a real
 * persist when the editor swap lands (the action id survives that swap).
 */

export enum CodeEditorAction {
	Save = "code-editor.save",
	FilePrev = "code-editor.file-prev",
	FileNext = "code-editor.file-next",
	FocusReferences = "code-editor.focus-references",
	MoveLineUp = "code-editor.move-line-up",
	MoveLineDown = "code-editor.move-line-down",
	DuplicateLineUp = "code-editor.duplicate-line-up",
	DuplicateLineDown = "code-editor.duplicate-line-down",
	DeleteLine = "code-editor.delete-line",
	ToggleComment = "code-editor.toggle-comment",
	QuickOpen = "code-editor.quick-open",
	CommandPalette = "code-editor.command-palette",
	AddCursorAbove = "code-editor.add-cursor-above",
	AddCursorBelow = "code-editor.add-cursor-below",
	SelectNextOccurrence = "code-editor.select-next-occurrence",
	FoldAtCaret = "code-editor.fold",
	UnfoldAtCaret = "code-editor.unfold",
	UnfoldAll = "code-editor.unfold-all",
	FormatDocument = "code-editor.format-document",
}

export const CODE_EDITOR_CHORDS: Readonly<Record<CodeEditorAction, string>> = {
	[CodeEditorAction.Save]: "CmdOrCtrl+S",
	// File nav binds on the window; the buffer-scoped line ops below claim
	// the same Alt+Arrow chords while the textarea has focus and stop the
	// event before it reaches the window listener, so file nav still works
	// when focus is on the file list.
	[CodeEditorAction.FilePrev]: "Alt+ArrowUp",
	[CodeEditorAction.FileNext]: "Alt+ArrowDown",
	[CodeEditorAction.FocusReferences]: "CmdOrCtrl+Shift+R",
	[CodeEditorAction.MoveLineUp]: "Alt+ArrowUp",
	[CodeEditorAction.MoveLineDown]: "Alt+ArrowDown",
	[CodeEditorAction.DuplicateLineUp]: "Shift+Alt+ArrowUp",
	[CodeEditorAction.DuplicateLineDown]: "Shift+Alt+ArrowDown",
	[CodeEditorAction.DeleteLine]: "CmdOrCtrl+Shift+K",
	[CodeEditorAction.ToggleComment]: "CmdOrCtrl+/",
	// Quick-open / jump-to-file palette (9.7.5). Binds on the window and
	// preventDefaults the browser's print dialog via the shortcut layer.
	[CodeEditorAction.QuickOpen]: "CmdOrCtrl+P",
	// Action command palette (9.7.5) — lists the app's invokable actions
	// (not files) with fuzzy search, the sibling of quick-open.
	[CodeEditorAction.CommandPalette]: "CmdOrCtrl+Shift+P",
	// Multi-cursor (9.7.3): the keyboard column-selection path stacks
	// collapsed cursors vertically; Cmd+D grows an occurrence selection.
	[CodeEditorAction.AddCursorAbove]: "CmdOrCtrl+Alt+ArrowUp",
	[CodeEditorAction.AddCursorBelow]: "CmdOrCtrl+Alt+ArrowDown",
	[CodeEditorAction.SelectNextOccurrence]: "CmdOrCtrl+D",
	// Code folding (9.7.3) — buffer-scoped, like the line ops. Arrow keys
	// (the Xcode fold chords), NOT `Cmd+Alt+[`: macOS composes
	// Option+printable into dead/alt characters, so `event.key` never
	// matches the chord (the established Mod+Alt+digit gotcha).
	[CodeEditorAction.FoldAtCaret]: "CmdOrCtrl+Alt+ArrowLeft",
	[CodeEditorAction.UnfoldAtCaret]: "CmdOrCtrl+Alt+ArrowRight",
	[CodeEditorAction.UnfoldAll]: "CmdOrCtrl+Alt+Shift+ArrowRight",
	// Formatter (9.7.8). Not VSCode's `Shift+Alt+F` — same macOS
	// Option-composition gotcha as the fold chords.
	[CodeEditorAction.FormatDocument]: "CmdOrCtrl+Shift+F",
};
