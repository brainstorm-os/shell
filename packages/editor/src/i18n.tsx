/**
 * Editor i18n seam — every user-visible string the shared editor plugins
 * render (table toolbar, slash menu, block-gutter action menu, etc.) flows
 * through one typed `t` instead of importing a host app's `t` function.
 *
 * Why a seam instead of a prop drilled through every plugin: the plugins
 * sit anywhere in the composer tree, and most don't otherwise need to
 * know about the host app. A React Context lets `<BrainstormEditor>`
 * inject overrides once at the top and every plugin reads via
 * `useEditorT()`.
 *
 * Defaults are English. A host app passes `i18nOverrides` to
 * `<BrainstormEditor>` (a `Partial<EditorManifest>`) when its locale
 * layer is wired up. Apps that already maintain their own manifests
 * (Notes / Journal) keep doing so for their app-chrome strings — this
 * seam only owns the editor-internal strings, not the surrounding app UI.
 */

import { type TFunction, createT } from "@brainstorm/sdk/i18n";
import { type ReactNode, createContext, useContext, useMemo } from "react";

export type EditorI18nKey =
	// Table toolbar (TablesPlugin)
	| "editor.table.toolbar.region"
	| "editor.table.open"
	| "editor.table.rowAbove"
	| "editor.table.rowBelow"
	| "editor.table.colLeft"
	| "editor.table.colRight"
	| "editor.table.headerRow"
	| "editor.table.sortAsc"
	| "editor.table.sortDesc"
	| "editor.table.fillDown"
	| "editor.table.moveColLeft"
	| "editor.table.moveColRight"
	| "editor.table.deleteRow"
	| "editor.table.deleteCol"
	| "editor.table.deleteTable"
	// Block selection — aria-live announcements (BlockSelectionPlugin).
	| "editor.a11y.blocksSelected.one"
	| "editor.a11y.blocksSelected.other"
	// Block gutter (BlockGutterPlugin).
	| "editor.gutter.addBelow"
	| "editor.gutter.openMenu"
	// Block action menu (BlockActionMenu).
	| "editor.action.menu.region"
	| "editor.action.menu.turnIntoSection"
	| "editor.action.menu.colorSection"
	| "editor.action.menu.highlightSection"
	| "editor.action.menu.alignSection"
	| "editor.action.menu.indentSection"
	| "editor.action.menu.actionsSection"
	// Slash menu (SlashMenuPlugin).
	| "editor.slashMenu.region"
	| "editor.slashMenu.empty"
	// Inline formatting toolbar (InlineToolbarPlugin).
	| "editor.inline.toolbar.region"
	| "editor.inline.bold"
	| "editor.inline.italic"
	| "editor.inline.underline"
	| "editor.inline.strike"
	| "editor.inline.code"
	| "editor.inline.color"
	| "editor.inline.link"
	| "editor.inline.editLink"
	| "editor.inline.more"
	| "editor.inline.removeFormat"
	| "editor.inline.equation"
	| "editor.inline.mention"
	| "editor.inline.emoji"
	| "editor.inline.comment"
	| "editor.inline.overflow.region"
	| "editor.inline.color.region"
	| "editor.inline.color.text"
	| "editor.inline.color.highlight"
	| "editor.inline.color.default"
	| "editor.inline.color.swatchLabel"
	| "editor.inline.link.placeholder"
	| "editor.inline.link.commit"
	| "editor.inline.link.remove"
	| "editor.inline.colorName.gray"
	| "editor.inline.colorName.brown"
	| "editor.inline.colorName.orange"
	| "editor.inline.colorName.yellow"
	| "editor.inline.colorName.green"
	| "editor.inline.colorName.blue"
	| "editor.inline.colorName.purple"
	| "editor.inline.colorName.pink"
	| "editor.inline.colorName.red"
	// Standard block-command catalogue — the shared default set every app's
	// editor gets via `<StandardEditingPlugins>` (slash menu + action menu).
	| "editor.block.paragraph"
	| "editor.block.heading1"
	| "editor.block.heading2"
	| "editor.block.heading3"
	| "editor.block.bulletList"
	| "editor.block.numberedList"
	| "editor.block.todoList"
	| "editor.block.quote"
	| "editor.block.code"
	| "editor.block.callout"
	| "editor.block.divider"
	| "editor.block.toggle"
	| "editor.block.toggleHeading1"
	| "editor.block.toggleHeading2"
	| "editor.block.toggleHeading3"
	| "editor.block.table"
	| "editor.block.columns2"
	| "editor.block.columns3"
	// Canonical one-line descriptions for the shared catalogue (slash-menu
	// captions). Apps consume these so every surface reads identically.
	| "editor.block.paragraph.description"
	| "editor.block.heading1.description"
	| "editor.block.heading2.description"
	| "editor.block.heading3.description"
	| "editor.block.bulletList.description"
	| "editor.block.numberedList.description"
	| "editor.block.todoList.description"
	| "editor.block.quote.description"
	| "editor.block.code.description"
	| "editor.block.callout.description"
	| "editor.block.divider.description"
	| "editor.block.toggle.description"
	| "editor.block.toggleHeading1.description"
	| "editor.block.toggleHeading2.description"
	| "editor.block.toggleHeading3.description"
	| "editor.block.table.description"
	| "editor.block.columns2.description"
	| "editor.block.columns3.description"
	// Transclusion / live page reference — only surfaced when the host enables
	// transclusion (an entity context is present). Inserts the `!@` trigger so
	// the typeahead opens for picking the page to embed.
	| "editor.block.transclusion"
	| "editor.block.transclusion.description"
	| "editor.action.align.left"
	| "editor.action.align.center"
	| "editor.action.align.right"
	| "editor.action.align.justify"
	| "editor.action.indent.increase"
	| "editor.action.indent.decrease"
	| "editor.action.moveUp"
	| "editor.action.moveDown"
	| "editor.action.duplicate"
	| "editor.action.delete"
	// Empty-paragraph placeholder hint (EmptyParagraphHintPlugin).
	| "editor.placeholder.empty"
	// Emoji typeahead (EmojiTypeaheadPlugin).
	| "editor.emoji.region"
	| "editor.emoji.skinTone"
	// Code block toolbar (CodeBlockToolbarPlugin).
	| "editor.code.copy"
	| "editor.code.copied"
	| "editor.code.language"
	| "editor.code.plainText"
	| "editor.code.wrap"
	| "editor.code.lineNumbers"
	// Mention typeahead (MentionTypeaheadPlugin) + date-mention chip.
	| "editor.mention.region"
	| "editor.mention.empty"
	| "editor.mention.noResults"
	| "editor.date.caption"
	// Transclusion typeahead + node (TransclusionTypeaheadPlugin / TransclusionNode).
	| "editor.transclusion.region"
	| "editor.transclusion.empty"
	| "editor.transclusion.noResults"
	| "editor.transclusion.untitled"
	| "editor.transclusion.typeUnknown"
	| "editor.transclusion.subtitle"
	| "editor.transclusion.cycleElided"
	| "editor.transclusion.depthElided"
	// Embed / bookmark (EmbedPlugin + BookmarkNode).
	| "editor.bookmark.urlPlaceholder"
	| "editor.bookmark.titlePlaceholder"
	| "editor.bookmark.descPlaceholder"
	| "editor.bookmark.save"
	| "editor.bookmark.cancel"
	| "editor.bookmark.edit"
	| "editor.bookmark.convertEmbed"
	| "editor.embed.chooser.region"
	| "editor.embed.chooser.bookmark"
	| "editor.embed.chooser.embed"
	| "editor.embed.chooser.link"
	// Comments panel (CommentsPanel — B11.9).
	| "editor.comments.region"
	| "editor.comments.empty"
	| "editor.comments.mention.search"
	| "editor.comments.mention.empty"
	| "editor.comments.new.placeholder"
	| "editor.comments.new.submit"
	| "editor.comments.pending.cancel"
	| "editor.comments.reply.placeholder"
	| "editor.comments.reply.submit"
	| "editor.comments.resolve"
	| "editor.comments.reopen"
	| "editor.comments.delete"
	| "editor.comments.resolved"
	| "editor.comments.suggestion"
	| "editor.comments.anonymous"
	| "editor.comments.openThread"
	// Compact relative timestamps ("just now" / "5m" / "3h" / "2d"); older
	// comments fall back to an absolute date.
	| "editor.comments.time.justNow"
	| "editor.comments.time.minutes"
	| "editor.comments.time.hours"
	| "editor.comments.time.days"
	// Suggestion mode (B11.9).
	| "editor.comments.apply"
	| "editor.comments.reject"
	| "editor.comments.applyFailed"
	| "editor.comments.suggest.toggle"
	| "editor.comments.suggest.placeholder"
	// Right-panel tab strip (CommentsRightPanel — B11.9).
	| "editor.rightPanel.tabs"
	| "editor.rightPanel.properties"
	| "editor.rightPanel.comments"
	// Media block commands (createMediaBlockCommands) + the click-to-edit
	// inspector (MediaInspectorPlugin). Surfaced when the host enables the
	// `media` flag on `<FullEditorPlugins>` and wires `uploadFile`.
	| "editor.media.image"
	| "editor.media.image.description"
	| "editor.media.video"
	| "editor.media.video.description"
	| "editor.media.audio"
	| "editor.media.audio.description"
	| "editor.media.file"
	| "editor.media.file.description"
	| "editor.media.inspector.region"
	| "editor.media.inspector.altLabel"
	| "editor.media.inspector.altPlaceholder"
	| "editor.media.inspector.captionLabel"
	| "editor.media.inspector.captionPlaceholder"
	| "editor.media.inspector.alignmentLabel"
	| "editor.media.inspector.align.left"
	| "editor.media.inspector.align.center"
	| "editor.media.inspector.align.right"
	| "editor.media.inspector.align.wide"
	| "editor.media.inspector.widthLabel"
	| "editor.media.inspector.delete"
	| "editor.media.inspector.close";

export type EditorManifest = Record<EditorI18nKey, string>;

export const EDITOR_I18N_DEFAULTS: EditorManifest = Object.freeze({
	"editor.table.toolbar.region": "Table controls",
	"editor.table.open": "Table actions",
	"editor.table.rowAbove": "Row above",
	"editor.table.rowBelow": "Row below",
	"editor.table.colLeft": "Column left",
	"editor.table.colRight": "Column right",
	"editor.table.headerRow": "Header row",
	"editor.table.sortAsc": "Sort column A→Z",
	"editor.table.sortDesc": "Sort column Z→A",
	"editor.table.fillDown": "Fill down",
	"editor.table.moveColLeft": "Move column left",
	"editor.table.moveColRight": "Move column right",
	"editor.table.deleteRow": "Delete row",
	"editor.table.deleteCol": "Delete column",
	"editor.table.deleteTable": "Delete table",
	"editor.a11y.blocksSelected.one": "1 block selected",
	"editor.a11y.blocksSelected.other": "{count} blocks selected",
	"editor.gutter.addBelow": "Add block below",
	"editor.gutter.openMenu": "Open block menu",
	"editor.action.menu.region": "Block actions",
	"editor.action.menu.turnIntoSection": "Turn into",
	"editor.action.menu.colorSection": "Text color",
	"editor.action.menu.highlightSection": "Highlight",
	"editor.action.menu.alignSection": "Align",
	"editor.action.menu.indentSection": "Indent",
	"editor.action.menu.actionsSection": "Actions",
	"editor.inline.toolbar.region": "Text formatting",
	"editor.inline.bold": "Bold",
	"editor.inline.italic": "Italic",
	"editor.inline.underline": "Underline",
	"editor.inline.strike": "Strikethrough",
	"editor.inline.code": "Inline code",
	"editor.inline.color": "Text color",
	"editor.inline.link": "Add link",
	"editor.inline.editLink": "Edit link",
	"editor.inline.more": "More",
	"editor.inline.removeFormat": "Remove formatting",
	"editor.inline.equation": "Inline equation",
	"editor.inline.mention": "Mention",
	"editor.inline.emoji": "Emoji",
	"editor.inline.comment": "Comment",
	"editor.inline.overflow.region": "More formatting",
	"editor.inline.color.region": "Colors",
	"editor.inline.color.text": "Text",
	"editor.inline.color.highlight": "Highlight",
	"editor.inline.color.default": "Default",
	"editor.inline.color.swatchLabel": "{group}: {color}",
	"editor.inline.link.placeholder": "Paste or type a link…",
	"editor.inline.link.commit": "Apply link",
	"editor.inline.link.remove": "Remove link",
	"editor.inline.colorName.gray": "Gray",
	"editor.inline.colorName.brown": "Brown",
	"editor.inline.colorName.orange": "Orange",
	"editor.inline.colorName.yellow": "Yellow",
	"editor.inline.colorName.green": "Green",
	"editor.inline.colorName.blue": "Blue",
	"editor.inline.colorName.purple": "Purple",
	"editor.inline.colorName.pink": "Pink",
	"editor.inline.colorName.red": "Red",
	"editor.slashMenu.region": "Block menu",
	"editor.slashMenu.empty": "No matches",
	"editor.block.paragraph": "Text",
	"editor.block.heading1": "Heading 1",
	"editor.block.heading2": "Heading 2",
	"editor.block.heading3": "Heading 3",
	"editor.block.bulletList": "Bulleted list",
	"editor.block.numberedList": "Numbered list",
	"editor.block.todoList": "To-do list",
	"editor.block.quote": "Quote",
	"editor.block.code": "Code",
	"editor.block.callout": "Callout",
	"editor.block.divider": "Divider",
	"editor.block.toggle": "Toggle list",
	"editor.block.toggleHeading1": "Toggle heading 1",
	"editor.block.toggleHeading2": "Toggle heading 2",
	"editor.block.toggleHeading3": "Toggle heading 3",
	"editor.block.table": "Table",
	"editor.block.columns2": "2 columns",
	"editor.block.columns3": "3 columns",
	"editor.block.paragraph.description": "Plain paragraph",
	"editor.block.heading1.description": "Largest section title",
	"editor.block.heading2.description": "Medium section title",
	"editor.block.heading3.description": "Smaller section title",
	"editor.block.bulletList.description": "Unordered list",
	"editor.block.numberedList.description": "Ordered list",
	"editor.block.todoList.description": "Checklist with checkboxes",
	"editor.block.quote.description": "Indented quotation",
	"editor.block.code.description": "Monospaced code block",
	"editor.block.callout.description": "Highlighted info / tip / warning box",
	"editor.block.divider.description": "Visual separator between sections",
	"editor.block.toggle.description": "Collapsible block that hides its content",
	"editor.block.toggleHeading1.description": "Collapsible large section heading",
	"editor.block.toggleHeading2.description": "Collapsible medium section heading",
	"editor.block.toggleHeading3.description": "Collapsible small section heading",
	"editor.block.table.description": "Rows and columns of cells",
	"editor.block.columns2.description": "Side-by-side two-column layout",
	"editor.block.columns3.description": "Side-by-side three-column layout",
	"editor.block.transclusion": "Reference",
	"editor.block.transclusion.description": "Embed a live view of another page",
	"editor.action.align.left": "Align left",
	"editor.action.align.center": "Align center",
	"editor.action.align.right": "Align right",
	"editor.action.align.justify": "Justify",
	"editor.action.indent.increase": "Indent",
	"editor.action.indent.decrease": "Outdent",
	"editor.action.moveUp": "Move up",
	"editor.action.moveDown": "Move down",
	"editor.action.duplicate": "Duplicate",
	"editor.action.delete": "Delete",
	"editor.placeholder.empty": "Type ‘/’ for commands",
	"editor.emoji.region": "Insert emoji",
	"editor.emoji.skinTone": "Skin tone",
	"editor.code.copy": "Copy",
	"editor.code.copied": "Copied",
	"editor.code.language": "Language",
	"editor.code.plainText": "Plain text",
	"editor.code.wrap": "Wrap",
	"editor.code.lineNumbers": "Lines",
	"editor.mention.region": "Mention an entity",
	"editor.mention.empty": "Type a name to mention something in your vault",
	"editor.mention.noResults": "Nothing matches “{query}”",
	"editor.date.caption": "Date",
	"editor.transclusion.region": "Transclude an entity",
	"editor.transclusion.empty": "Type a name to transclude something from your vault",
	"editor.transclusion.noResults": "Nothing matches “{query}”",
	"editor.transclusion.untitled": "Untitled",
	"editor.transclusion.typeUnknown": "Object",
	"editor.transclusion.subtitle": "Transcluded {type}",
	"editor.transclusion.cycleElided": "Already shown above — open to view",
	"editor.transclusion.depthElided": "Nested too deeply to show — open to view",
	"editor.bookmark.urlPlaceholder": "Paste a link…",
	"editor.bookmark.titlePlaceholder": "Title (optional)",
	"editor.bookmark.descPlaceholder": "Description (optional)",
	"editor.bookmark.save": "Save",
	"editor.bookmark.cancel": "Cancel",
	"editor.bookmark.edit": "Edit",
	"editor.bookmark.convertEmbed": "Convert to embed",
	"editor.embed.chooser.region": "Paste options",
	"editor.embed.chooser.bookmark": "Create bookmark",
	"editor.embed.chooser.embed": "Embed",
	"editor.embed.chooser.link": "Plain link",
	"editor.comments.region": "Comments",
	"editor.comments.empty": "No comments yet",
	"editor.comments.mention.search": "Mention a member",
	"editor.comments.mention.empty": "No members",
	"editor.comments.new.placeholder": "Add a comment…",
	"editor.comments.new.submit": "Comment",
	"editor.comments.pending.cancel": "Cancel",
	"editor.comments.reply.placeholder": "Reply…",
	"editor.comments.reply.submit": "Reply",
	"editor.comments.resolve": "Resolve",
	"editor.comments.reopen": "Reopen",
	"editor.comments.delete": "Delete",
	"editor.comments.resolved": "Resolved",
	"editor.comments.suggestion": "Suggestion",
	"editor.comments.anonymous": "Anonymous",
	"editor.comments.openThread": "View comments",
	"editor.comments.time.justNow": "just now",
	"editor.comments.time.minutes": "{count}m",
	"editor.comments.time.hours": "{count}h",
	"editor.comments.time.days": "{count}d",
	"editor.comments.apply": "Apply",
	"editor.comments.reject": "Reject",
	"editor.comments.applyFailed": "Couldn't apply — the quoted text has changed.",
	"editor.comments.suggest.toggle": "Suggest a change",
	"editor.comments.suggest.placeholder": "Replacement text…",
	"editor.rightPanel.tabs": "Panel tabs",
	"editor.rightPanel.properties": "Properties",
	"editor.rightPanel.comments": "Comments",
	"editor.media.image": "Image",
	"editor.media.image.description": "Upload or embed an image",
	"editor.media.video": "Video",
	"editor.media.video.description": "Upload or embed a video",
	"editor.media.audio": "Audio",
	"editor.media.audio.description": "Upload an audio clip",
	"editor.media.file": "File",
	"editor.media.file.description": "Attach any file as a download",
	"editor.media.inspector.region": "Media settings",
	"editor.media.inspector.altLabel": "Alt text",
	"editor.media.inspector.altPlaceholder": "Describe the image",
	"editor.media.inspector.captionLabel": "Caption",
	"editor.media.inspector.captionPlaceholder": "Add a caption",
	"editor.media.inspector.alignmentLabel": "Alignment",
	"editor.media.inspector.align.left": "Left",
	"editor.media.inspector.align.center": "Center",
	"editor.media.inspector.align.right": "Right",
	"editor.media.inspector.align.wide": "Wide",
	"editor.media.inspector.widthLabel": "Width",
	"editor.media.inspector.delete": "Delete",
	"editor.media.inspector.close": "Done",
});

export type EditorT = TFunction<EditorManifest>;

/** Build an `EditorT` for callers outside the React tree (e.g. unit
 *  tests, headless tools). React callers should prefer `useEditorT()`. */
export function createEditorT(overrides?: Partial<EditorManifest>): EditorT {
	return createT(EDITOR_I18N_DEFAULTS, overrides);
}

const DEFAULT_EDITOR_T: EditorT = createEditorT();

const EditorI18nContext = createContext<EditorT>(DEFAULT_EDITOR_T);

export type EditorI18nProviderProps = {
	overrides?: Partial<EditorManifest>;
	children: ReactNode;
};

/** Wraps the editor plugin tree. `<BrainstormEditor>` mounts this
 *  automatically; consumers only need to render it directly when they
 *  use shared editor plugins outside `<BrainstormEditor>` (e.g. a
 *  preview surface that hand-wires a Lexical composer). */
export function EditorI18nProvider({ overrides, children }: EditorI18nProviderProps): ReactNode {
	const t = useMemo<EditorT>(() => {
		if (!overrides || Object.keys(overrides).length === 0) return DEFAULT_EDITOR_T;
		return createEditorT(overrides);
	}, [overrides]);
	return <EditorI18nContext.Provider value={t}>{children}</EditorI18nContext.Provider>;
}

/** Read the editor's translate function. Returns the English defaults
 *  when no provider is mounted, so unit-tested plugin renders don't
 *  require a wrapper. */
export function useEditorT(): EditorT {
	return useContext(EditorI18nContext);
}
