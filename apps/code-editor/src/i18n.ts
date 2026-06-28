/**
 * Code-Editor English string manifest + the app-side `t()`.
 *
 * Every user-visible string in the renderer flows through `t(key)` from
 * `@brainstorm/sdk/i18n` (the shared app-side translator — `{name}`
 * interpolation, override-able per locale). No bare literals in `app.ts`
 * per §Localization. Object-menu
 * chrome is localised through the same manifest where it overlaps.
 */

import { type TParams, createT, plural as sdkPlural } from "@brainstorm/sdk/i18n";

export const CODE_EDITOR_MESSAGES = {
	appTitle: "Code Editor",
	filesRegion: "Code files",
	filesHeading: "Files",
	newFile: "New",
	newFileHint: "Create a new code file",
	fileUnsaved: "Unsaved changes",
	"diagnostics.region": "Problems",
	"diagnostics.clean": "No problems",
	"diagnostics.summary": "{errors} errors · {warnings} warnings",
	"diagnostics.lineLabel": "L{line}",
	"diagnostics.reveal": "Go to line {line}",
	"diagnostics.msg.trailingWhitespace": "Trailing whitespace.",
	"diagnostics.msg.mixedIndent": "Mixed tabs and spaces in indentation.",
	"diagnostics.msg.unmatchedBracket": "Unmatched “{ch}”.",
	"diagnostics.msg.unclosedBracket": "Unclosed “{ch}”.",
	metaFilesOne: "{count} file",
	metaFilesMany: "{count} files",
	metaUnsaved: "{count} files · {dirty} unsaved",
	metaUnsavedOne: "{count} file · {dirty} unsaved",
	emptyTitle: "No code files yet",
	emptySub: "Snippets, configs, and REPL scratch files you create in this vault open here.",
	emptyNewFile: "New file",
	bufferLabel: "Source of {name}",
	referencesRegion: "Plan references",
	referencesHeading: "References",
	referencesEmpty: "No plan or open-question ids referenced in this file.",
	referenceOpen: "Open {code} — {title}",
	referenceOccurrences: "{count} occurrences (first on line {line})",
	referenceCount: "×{count}",
	kindIteration: "Iteration",
	kindOpenQuestion: "Open question",
	citationHoverClose: "Dismiss citation",
	citationHoverOpen: "Open",
	menuMoreActions: "More actions for {name}",
	menuRegion: "File actions",
	menuOpen: "Open",
	menuRename: "Rename",
	renameTitle: "Rename {name}",
	renameLabel: "File name",
	renameSave: "Rename",
	renameCancel: "Cancel",
	renameErrorEmpty: "Enter a file name.",
	renameErrorDuplicate: "A file with that name already exists.",
	deleteTitle: "Delete {name}?",
	deleteBody: "“{name}” will be moved to the bin. This can't be undone here.",
	deleteConfirm: "Delete",
	deleteCancel: "Cancel",
	wrapEnable: "Enable line wrap",
	wrapDisable: "Disable line wrap",
	"completion.listLabel": "Completions",
	"syntaxTheme.heading": "Syntax theme",
	"syntaxTheme.auto": "Match appearance",
	"syntaxTheme.light": "GitHub Light",
	"syntaxTheme.dark": "GitHub Dark",
	fileIconSelect: "Select {name}",
	"navToggle.show": "Show files",
	"navToggle.hide": "Hide files",
	"header.lock": "Lock file (read-only)",
	"header.unlock": "Unlock file",
	"refsToggle.show": "Show references",
	"refsToggle.hide": "Hide references",
	quickOpenLabel: "Quick open file",
	quickOpenPlaceholder: "Jump to a file by name…",
	quickOpenEmpty: "No matching files",
	commandPaletteLabel: "Run a command",
	commandPalettePlaceholder: "Search commands by name…",
	commandPaletteEmpty: "No matching commands",
	"command.save": "Save file",
	"command.newFile": "New file",
	"command.focusReferences": "Focus references",
	"command.toggleWrap": "Toggle line wrap",
	"command.toggleFiles": "Toggle files panel",
	"command.toggleReferences": "Toggle references panel",
	"command.quickOpen": "Quick open file…",
	"command.find": "Find in file…",
	"command.replace": "Find and replace…",
	"command.formatDocument": "Format document",
	"command.fold": "Fold region at cursor",
	"command.unfold": "Unfold region at cursor",
	"command.unfoldAll": "Unfold all regions",
	"formatOnSave.enable": "Enable format on save",
	"formatOnSave.disable": "Disable format on save",
	"diff.show": "Show changes since save",
	"diff.modeHeading": "Diff layout",
	"diff.modeSideBySide": "Side by side",
	"diff.modeUnified": "Unified",
	"diff.title": "Changes in {name}",
	"diff.close": "Close diff",
	"diff.stats": "{added} added · {removed} removed",
	"diff.noChanges": "No changes since the last save.",
	"diff.baseColumn": "Saved",
	"diff.nextColumn": "Current",
} as const;

export type CodeEditorMessageKey = keyof typeof CODE_EDITOR_MESSAGES;

export const t = createT(CODE_EDITOR_MESSAGES);

/** Catalog-bound plural — picks `<base>One` / `<base>Many`. The count
 *  selection lives in the shared helper, not in component code. */
export const plural = (
	count: number,
	oneKey: CodeEditorMessageKey,
	otherKey: CodeEditorMessageKey,
	params?: TParams,
): string => sdkPlural(t, count, oneKey, otherKey, params);
