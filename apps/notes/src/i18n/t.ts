/**
 * Notes-app translate function. Mirrors the shell's
 * `renderer/i18n/t.ts`: id-keyed lookups against a default-English
 * manifest, `{param}` interpolation, missing-key warning in dev.
 *
 * Per CLAUDE.md §Localization: every user-visible string wraps in
 * `t(key)` from day one — including screen-reader strings inside
 * `aria-live` regions, even though they aren't visually rendered. When
 * the shell's locale layer lands (Stage 12), this loader swaps and call
 * sites stay untouched.
 */

import { createT } from "@brainstorm/sdk/i18n";

const DEFAULTS: Record<string, string> = {
	// Block selection — aria-live announcements.
	"notes.a11y.blocksSelected.one": "1 block selected",
	"notes.a11y.blocksSelected.other": "{count} blocks selected",

	// App chrome.
	"notes.app.title": "Notes",
	"notes.header.newNote": "New note",
	"notes.header.lock": "Lock page (read-only)",
	"notes.header.unlock": "Unlock page",
	"notes.sidebar.show": "Show notes list",
	"notes.sidebar.hide": "Hide notes list",
	"notes.sidebar.region": "Notes list",
	"notes.sidebar.resize": "Resize notes list",
	"notes.search.placeholder": "Search notes…",
	"notes.search.clear": "Clear search",
	"notes.search.empty": "No notes match your search.",
	"notes.state.loading": "Loading…",
	"notes.empty.title": "No notes yet.",
	"notes.empty.hint": "Press {action} to start writing.",
	"notes.list.region": "Recent notes",
	"notes.list.untitled": "Untitled",
	// Dashboard widget (Stage 7.3). Title / open chrome is drawn by the shell's
	// widget strip; the app supplies the body — empty-state copy + the in-widget
	// sort control.
	"notes.widget.empty": "No notes yet",
	"notes.widget.sort.label": "Sort notes",
	"notes.widget.sort.edited": "Recently edited",
	"notes.widget.sort.created": "Recently created",
	"notes.widget.sort.title": "Title (A–Z)",
	"notes.widget.count.one": "{count} note",
	"notes.widget.count.other": "{count} notes",
	// Date-section headers — rows are grouped by when they were last
	// edited instead of carrying a per-row "edited 4m ago" caption.
	"notes.list.section.today": "Today",
	"notes.list.section.yesterday": "Yesterday",
	"notes.list.section.last7": "Previous 7 days",
	"notes.list.section.last30": "Previous 30 days",

	// Shared object menu (right-click + ⋯ on the note title / list rows).
	"notes.objectMenu.open": "Open",
	"notes.objectMenu.pin": "Pin to dashboard",
	"notes.objectMenu.unpin": "Remove from dashboard",
	"notes.objectMenu.share": "Share…",
	"notes.objectMenu.saveAsTemplate": "Save as template",
	"notes.objectMenu.remove": "Delete note",

	// Collab-C5 share dialog.
	"notes.share.title": "Share note",
	"notes.share.membersHeading": "People with access",
	"notes.share.you": "you",
	"notes.share.roleOwner": "Owner",
	"notes.share.roleEditor": "Can edit",
	"notes.share.roleViewer": "Can view",
	"notes.share.revoke": "Remove access",
	"notes.share.addHeading": "Add a person",
	"notes.share.codePlaceholder": "Paste an invite code",
	"notes.share.canEdit": "Can edit",
	"notes.share.canView": "Can view",
	"notes.share.add": "Add",
	"notes.share.quickAdd": "Add a teammate",
	"notes.share.inviteHeading": "Your invite code",
	"notes.share.getCode": "Get my invite code",
	"notes.share.copy": "Copy",
	"notes.share.copied": "Copied",
	"notes.share.inviteHint": "Share this code with someone so they can add you to their notes.",
	"notes.share.shareFailed": "Couldn't share — check the invite code and try again.",
	"notes.share.revokeFailed": "Couldn't remove access. Try again.",
	"notes.share.loadFailed": "Couldn't load who has access.",
	"notes.share.done": "Done",
	"notes.objectMenu.region": "Note actions",
	"notes.objectMenu.more": "Note actions",
	"notes.objectMenu.addToCollection": "Add to collection…",
	"notes.objectMenu.collectionsRegion": "Collections",
	"notes.objectMenu.noCollections": "No collections yet",
	"notes.export.markdown": "Export as Markdown",
	"notes.export.html": "Export as HTML",
	"notes.export.pdf": "Export as PDF",
	"notes.export.dialogTitle": "Export note",
	"notes.export.action": "Export…",
	"notes.export.formatLegend": "Format",
	"notes.export.cancel": "Cancel",
	"notes.export.markdownFilter": "Markdown",
	"notes.export.htmlFilter": "HTML",
	"notes.export.pdfFilter": "PDF",

	// Block commands — Notes-only entries; the generic catalogue (paragraph /
	// headings / lists / quote / code / callout / divider / toggle / table /
	// columns + the action set) reads from the shared `@brainstorm/editor`
	// catalogue since 9.18.3c(d).
	"notes.command.image.label": "Image",
	"notes.command.image.description": "Embed a picture",
	"notes.command.video.label": "Video",
	"notes.command.video.description": "Embed a video clip",

	// Templates (B11.10) — `/template` slash command + "Save selection as
	// template" block action + snippet naming.
	"notes.command.template.label": "Template",
	"notes.command.template.description": "Insert a saved block template",
	"notes.command.template.pickerLabel": "Insert template",
	"notes.command.template.untitled": "Untitled template",
	"notes.template.defaultName": "Snippet",

	// Block-action menu — Notes-only actions (the generic turn-into / align /
	// indent / move / duplicate / delete actions come from the shared catalogue).
	"notes.action.copyLink.label": "Copy link to block",
	"notes.action.copyLink.description": "Copy a link that points to this block",
	"notes.action.saveAsTemplate.label": "Save selection as template",
	"notes.action.saveAsTemplate.description": "Save the selected blocks as a reusable template",

	// Gutter affordances.
	"notes.gutter.openMenu": "Block actions",
	"notes.gutter.addBelow": "Add block below",

	// Inline formatting toolbar.
	"notes.inline.toolbar.region": "Text formatting",
	"notes.inline.bold": "Bold",
	"notes.inline.italic": "Italic",
	"notes.inline.underline": "Underline",
	"notes.inline.strike": "Strikethrough",
	"notes.inline.code": "Inline code",
	"notes.inline.color": "Text colour",
	"notes.inline.color.region": "Text colour and highlight",
	"notes.inline.color.text": "Text",
	"notes.inline.color.highlight": "Highlight",
	"notes.inline.color.default": "Default",
	"notes.color.gray": "Gray",
	"notes.color.brown": "Brown",
	"notes.color.orange": "Orange",
	"notes.color.yellow": "Yellow",
	"notes.color.green": "Green",
	"notes.color.blue": "Blue",
	"notes.color.purple": "Purple",
	"notes.color.pink": "Pink",
	"notes.color.red": "Red",
	"notes.inline.more": "More",
	"notes.inline.overflow.region": "More formatting",
	"notes.inline.removeFormat": "Remove formatting",
	"notes.inline.equation": "Inline equation",
	"notes.inline.mention": "Mention",
	"notes.inline.emoji": "Emoji",
	"notes.inline.link": "Add link",
	"notes.inline.editLink": "Edit link",
	"notes.inline.link.placeholder": "Paste link",
	"notes.inline.link.commit": "Apply link",
	"notes.inline.link.remove": "Remove link",

	// Table of contents block.
	"notes.command.toc.label": "Table of contents",
	"notes.command.toc.description": "Auto-updating list of the document's headings",
	"notes.toc.region": "Table of contents",
	"notes.toc.heading": "Contents",
	"notes.toc.empty": "Add headings to build a table of contents.",
	"notes.toc.untitled": "Untitled heading",
	"notes.backlinks.region": "Linked references",
	"notes.backlinks.title": "Linked references",
	"notes.backlinks.untitled": "Untitled",
	"notes.command.subpage.label": "Sub-page",
	"notes.command.subpage.description": "Create a nested page and link it here",
	"notes.pageRef.untitled": "Untitled",
	"notes.command.equation.label": "Equation",
	"notes.command.equation.description": "Block of LaTeX maths",
	"notes.command.checkbox.label": "Checkbox",
	"notes.command.checkbox.description": "Inline checkable field (use in a table cell)",
	"notes.command.date.label": "Date",
	"notes.command.date.description": "Inline editable date field (use in a table cell)",
	"notes.command.number.label": "Number",
	"notes.command.number.description": "Inline editable number field (use in a table cell)",
	"notes.command.select.label": "Select",
	"notes.command.select.description":
		"Inline single-select field with its own options (use in a table cell)",
	"notes.select.placeholder": "Select",
	"notes.select.noOptions": "No options yet",
	"notes.select.addOption": "Add option…",
	"notes.select.remove": "Remove option",
	"notes.select.menuRegion": "Select an option",
	"notes.equation.placeholder": "E = mc^2",
	"notes.equation.edit": "Edit equation",
	"notes.command.audio.label": "Audio",
	"notes.command.audio.description": "Attach an audio clip with a player",
	"notes.command.file.label": "File",
	"notes.command.file.description": "Attach any file as a download",
	"notes.command.bookmark.label": "Bookmark",
	"notes.command.bookmark.description": "A link rendered as a rich card",
	"notes.bookmark.urlPlaceholder": "Paste a link…",
	"notes.bookmark.titlePlaceholder": "Title (optional)",
	"notes.bookmark.descPlaceholder": "Description (optional)",
	"notes.bookmark.save": "Save",
	"notes.bookmark.cancel": "Cancel",
	"notes.bookmark.edit": "Edit",
	"notes.bookmark.convertEmbed": "Convert to embed",
	"notes.embed.chooser.region": "Paste options",
	"notes.embed.chooser.bookmark": "Create bookmark",
	"notes.embed.chooser.embed": "Embed",
	"notes.embed.chooser.link": "Plain link",
	"notes.embed.chooser.dismiss": "Dismiss",

	// Paste-URL → embedded-bookmark suggestion (9.18.2b). A bare URL paste
	// drops a plain link plus this non-modal prompt; accept swaps it for the
	// live bookmark card, dismiss keeps the link.
	"notes.bookmarkSuggest.region": "Pasted link",
	"notes.bookmarkSuggest.prompt": "Convert this link to a bookmark card?",
	"notes.bookmarkSuggest.accept": "Convert to bookmark card",
	"notes.bookmarkSuggest.dismiss": "Keep as link",

	// `/embed` slash command + entity picker (B9.4.1 snapshot card).
	"notes.command.embed.label": "Embed",
	"notes.command.embed.description": "Insert a preview card pointing at another vault object",
	// `/database` slash command (9.12.12) — same picker, scoped to Lists.
	"notes.command.database.label": "Database",
	"notes.command.database.description": "Embed a live database list inline",
	// `/graph` slash command — the embed picker scoped to saved Graphs (9.13.12).
	"notes.command.graph.label": "Graph",
	"notes.command.graph.description": "Embed a saved graph of your vault",
	// `/book` slash command — the embed picker scoped to book Highlights (9.21.7).
	"notes.command.book.label": "Book highlight",
	"notes.command.book.description": "Embed a highlight from one of your books",
	"notes.embed.menu.emptyFiltered": "No matching objects in your vault yet",
	"notes.embed.menu.region": "Embed an object",
	"notes.embed.menu.results": "Object results",
	"notes.embed.menu.search": "Search vault objects",
	"notes.embed.menu.placeholder": "Search objects to embed…",
	"notes.embed.menu.empty": "Type to find an object in your vault",
	"notes.embed.menu.noResults": "Nothing matches “{query}”",
	"notes.embed.untitled": "Untitled",
	"notes.embed.typeUnknown": "Object",
	"notes.embed.providedBy": "{type} · provided by {app}",

	// Empty paragraph hint.
	"notes.placeholder.empty": "Type ‘/’ for commands",

	// Media inspector (B5c).
	"notes.mediaInspector.region": "Media inspector",
	"notes.mediaInspector.altLabel": "Alt text",
	"notes.mediaInspector.altPlaceholder": "Describe this image for screen readers",
	"notes.mediaInspector.captionLabel": "Caption",
	"notes.mediaInspector.captionPlaceholder": "Add a caption",
	"notes.mediaInspector.alignmentLabel": "Alignment",
	"notes.mediaInspector.align.left": "Left",
	"notes.mediaInspector.align.center": "Center",
	"notes.mediaInspector.align.right": "Right",
	"notes.mediaInspector.align.wide": "Full width",
	"notes.mediaInspector.widthLabel": "Width",
	"notes.mediaInspector.delete": "Delete",
	"notes.mediaInspector.close": "Close",

	// Property cells.
	"notes.cell.empty": "Empty",
	"notes.cell.editValueFor": "Edit value for {name}",
	"notes.cell.toggleValueFor": "Toggle {name}",

	// Tag / TagList cell (text + vocabulary).
	"notes.tag.pickerRegion": "Choose values for {name}",
	"notes.tag.search": "Search values",
	"notes.tag.searchPlaceholder": "Search values…",
	"notes.tag.options": "Available values",
	"notes.tag.noValues": "No values yet",
	"notes.tag.remove": "Remove {label}",
	"notes.tag.manageValues": "Manage values…",

	// Date cell (natural-language popover, B5.9).
	"notes.date.pickerRegion": "Set a date for {name}",
	"notes.date.input": "Date",
	"notes.date.placeholder": "e.g. tomorrow, next monday, 2026-06-01",
	"notes.date.hint": "Type a date or a phrase like “in 3 days”.",
	"notes.date.unrecognised": "Couldn’t read that date",
	"notes.date.set": "Set",
	"notes.date.clear": "Clear",

	// Formatted text validation (Url / Email / Phone, B5.9).
	"notes.format.invalidUrl": "Not a valid URL",
	"notes.format.invalidEmail": "Not a valid email address",
	"notes.format.invalidPhone": "Not a valid phone number",

	// File-aware cells (upload pipeline pending, B5.9).
	"notes.file.region": "Files for {name}",
	"notes.file.empty": "No files",
	"notes.file.uploadsPending": "File uploads land when the storage upload API is wired up.",

	// Link cells (stubbed note picker, B5.9).
	"notes.link.pickerRegion": "Link {name} to a note",
	"notes.link.search": "Search notes",
	"notes.link.searchPlaceholder": "Search notes to link…",
	"notes.link.options": "Linkable notes",
	"notes.link.noResults": "No notes to link yet",

	// Dictionary editor (B5.8).
	"notes.dict.region": "Dictionary editor",
	"notes.dict.nameLabel": "Dictionary name",
	"notes.dict.count": "{n} values",
	"notes.dict.close": "Close",
	"notes.dict.search": "Search values",
	"notes.dict.searchPlaceholder": "Search values…",
	"notes.dict.sortLabel": "Sort",
	"notes.dict.sort.manual": "Manual",
	"notes.dict.sort.alpha": "A → Z",
	"notes.dict.sort.alphaDesc": "Z → A",
	"notes.dict.sort.mostUsed": "Most used",
	"notes.dict.addItem": "Add value",
	"notes.dict.importExport": "Import / export",
	"notes.dict.importLabel": "Paste CSV, TSV, or JSON",
	"notes.dict.importPlaceholder": "label,icon,description — or JSON",
	"notes.dict.importCommit": "Import",
	"notes.dict.exportJson": "Export JSON",
	"notes.dict.importFailed": "Couldn’t import: {reason}",
	"notes.dict.importTruncated":
		"Imported the first {n} values; the rest were skipped (too many rows).",
	"notes.dict.itemsRegion": "Dictionary values",
	"notes.dict.noItems": "No values yet",
	"notes.dict.itemLabel": "Value label",
	"notes.dict.usage": "{n} notes",
	"notes.dict.reorder": "Reorder {label}",
	"notes.dict.rowMenu": "Actions for {label}",
	"notes.dict.startMerge": "Merge into…",
	"notes.dict.mergeInto": "Merge here",
	"notes.dict.archive": "Archive",
	"notes.dict.delete": "Delete",
	"notes.dict.showArchived": "Show archived ({n})",
	"notes.dict.archivedRegion": "Archived values",
	"notes.dict.unarchive": "Unarchive",

	// `:`-shortcode emoji typeahead.
	"notes.emoji.region": "Insert emoji",
	"notes.emoji.skinTone": "Skin tone",
	"notes.code.copy": "Copy",
	"notes.code.copied": "Copied",
	"notes.code.language": "Language",
	"notes.code.plainText": "Plain text",
	"notes.code.wrap": "Wrap",
	"notes.code.lineNumbers": "Lines",
	// `@`-mention typeahead.
	"notes.mention.region": "Mention an entity",
	"notes.mention.empty": "Type a name to mention something in your vault",
	"notes.mention.noResults": "Nothing matches “{query}”",
	// `@date` typeahead option (lists alongside entity mentions).
	"notes.date.caption": "Date",

	// `!@` transclusion typeahead — live in-place reference to another object.
	"notes.transclusion.region": "Transclude an entity",
	"notes.transclusion.empty": "Type a name to transclude something from your vault",
	"notes.transclusion.noResults": "Nothing matches “{query}”",
	"notes.transclusion.cycleHint": "Transclusion would create a cycle through {label}",
	"notes.transclusion.depthHint": "Transclusion would nest deeper than {max} levels",
	"notes.transclusion.selfHint": "A note cannot transclude itself",
	"notes.transclusion.untitled": "Untitled",
	"notes.transclusion.typeUnknown": "Object",
	"notes.transclusion.subtitle": "Transcluded {type}",
	"notes.transclusion.openSource": "Open source",
	"notes.transclusion.cycleElided": "Already shown above — open to view",
	"notes.transclusion.depthElided": "Nested too deeply to show — open to view",

	// Link markup picker (Mod+K).
	"notes.linkMarkup.region": "Link to an entity",
	"notes.linkMarkup.searchPlaceholder": "Search entities to link",
	"notes.linkMarkup.empty": "Type a name to link your selection to an entity",
	"notes.linkMarkup.noResults": "Nothing matches “{query}”",
	"notes.linkMarkup.entityType.note": "Note",

	// Add-property menu (slash trigger, gutter, PropertyList "+").
	"notes.addProperty.region": "Add property",
	"notes.addProperty.search": "Search properties",
	"notes.addProperty.searchPlaceholder": "Search properties…",
	"notes.addProperty.results": "Property suggestions",
	"notes.addProperty.empty": "No matches",
	"notes.addProperty.emptyCatalog": "No properties in this vault yet.",
	"notes.addProperty.loading": "Loading properties…",
	"notes.addProperty.createNew": "Create new property",
	"notes.addProperty.gutter": "Add property",
	"notes.addProperty.listAddButton": "Add property",
	"notes.addProperty.typeMulti": "{type} · Multiple",
	"notes.addProperty.type.text": "Text",
	"notes.addProperty.type.number": "Number",
	"notes.addProperty.type.boolean": "Boolean",
	"notes.addProperty.type.date": "Date",
	"notes.addProperty.type.select": "Select",
	"notes.addProperty.type.url": "URL",
	"notes.addProperty.type.email": "Email",
	"notes.addProperty.type.phone": "Phone",
	"notes.addProperty.type.file": "File",
	"notes.addProperty.type.reference": "Reference",
	"notes.addProperty.type.richText": "Rich text",
	"notes.inlinePropertyForm.region": "Create new property",
	"notes.inlinePropertyForm.back": "Back to property picker",
	"notes.inlinePropertyForm.nameLabel": "Property name",
	"notes.inlinePropertyForm.namePlaceholder": "Property name",
	"notes.inlinePropertyForm.kindLabel": "Kind",
	"notes.inlinePropertyForm.formatLabel": "Format",
	"notes.inlinePropertyForm.multiLabel": "Allow multiple values",
	"notes.inlinePropertyForm.cancel": "Cancel",
	"notes.inlinePropertyForm.submit": "Create",
	"notes.inlinePropertyForm.moreOptionsHint":
		"For icons, descriptions, and vocabulary editing, open Settings → Data.",
	"notes.inlinePropertyForm.kind.text": "Text",
	"notes.inlinePropertyForm.kind.number": "Number",
	"notes.inlinePropertyForm.kind.boolean": "Boolean",
	"notes.inlinePropertyForm.kind.date": "Date",
	"notes.inlinePropertyForm.kind.select": "Select",
	"notes.inlinePropertyForm.kind.relation": "Relation",
	"notes.inlinePropertyForm.kind.file": "File",
	"notes.inlinePropertyForm.kind.formula": "Formula",
	"notes.inlinePropertyForm.formula.label": "Expression",
	"notes.inlinePropertyForm.formula.placeholder": "{price} * {quantity}",
	"notes.inlinePropertyForm.formula.hint":
		"Reference other properties with {braces}. Read-only, computed per row.",
	"notes.inlinePropertyForm.format.plain": "Plain",
	"notes.inlinePropertyForm.format.url": "URL",
	"notes.inlinePropertyForm.format.email": "Email",
	"notes.inlinePropertyForm.format.phone": "Phone",
	"notes.inlinePropertyForm.format.currency": "Currency",
	"notes.inlinePropertyForm.format.percent": "Percent",
	"notes.inlinePropertyForm.format.duration": "Duration",
	"notes.inlinePropertyForm.currencyLabel": "Currency",
	"notes.inlinePropertyForm.optionsLabel": "Options",
	"notes.inlinePropertyForm.optionsPlaceholder": "Lead, Qualified, Proposal, Won, Lost",
	"notes.inlinePropertyForm.optionsHint":
		"One per line, or comma-separated. Add more later in Settings → Data.",
	"notes.inlinePropertyForm.relationTargetLabel": "Links to",
	"notes.inlinePropertyForm.relationTargetAny": "Anything",
	"notes.command.property.label": "Property",
	"notes.command.property.description": "Insert a property block",
	"notes.action.addProperty.label": "Add property",
	"notes.action.addProperty.description": "Insert a property block after the selected block",

	// Property block + property-list block.
	"notes.property.unknown.label": "Property not found",
	"notes.property.unknown.hint":
		"Looking for property “{key}”. It may have been removed from this vault.",
	"notes.property.unavailableView.label": "View unavailable",
	"notes.property.unavailableView.hint": "“{view}” isn’t available for {kind} properties.",
	"notes.property.loading": "Loading properties…",
	"notes.propertyList.defaultTitle": "Properties",
	"notes.propertyList.empty": "No properties yet.",
	"notes.propertyList.collapse": "Collapse property list",
	"notes.propertyList.expand": "Expand property list",
	"notes.propertyList.region": "Property list",
	"notes.propertyList.addButton": "Add property",

	// Right-hand Properties panel.
	"notes.properties.title": "Properties",
	"notes.properties.region": "Note properties",
	"notes.properties.show": "Show properties",
	"notes.properties.hide": "Hide properties",
	"notes.properties.resize": "Resize properties panel",
	"notes.properties.empty": "No properties on this note yet.",
	"notes.properties.add": "Add property",
	"notes.properties.remove": "Remove {name}",
	"notes.properties.meta.created": "Created",
	"notes.properties.meta.updated": "Updated",

	// Icon picker.
	"notes.iconPicker.region": "Pick note icon",
	"notes.iconPicker.open": "Change note icon",
	"notes.iconPicker.remove": "Remove icon",
	"notes.iconPicker.close": "Close",
	"notes.iconPicker.search": "Search",
	"notes.iconPicker.noMatch": "No matches",
	"notes.iconPicker.tab.emoji": "Emoji",
	"notes.iconPicker.tab.icon": "Icon",
	"notes.iconPicker.tab.upload": "Upload",
	"notes.iconPicker.tab.library": "Library",
	"notes.iconPicker.upload.pending":
		"Custom-image uploads land when the SDK's icons service is wired up. Pick an emoji or an icon-pack glyph for now.",
	"notes.iconPicker.library.pending":
		"Your uploaded icons will appear here once the SDK's icons service is wired up.",
	"notes.iconPicker.upload.action": "Choose image…",
	"notes.iconPicker.upload.uploading": "Uploading…",
	"notes.iconPicker.library.empty": "No custom icons yet — upload one from the Upload tab.",
	"notes.iconPicker.skinTone": "Skin tone",
	"notes.iconPicker.tint": "Icon colour",

	"notes.coverPicker.open": "Change cover",
	"notes.coverPicker.add": "Add cover",
	"notes.coverPicker.region": "Pick note cover",
	"notes.coverPicker.close": "Close",
	"notes.coverPicker.remove": "Remove cover",
	"notes.coverPicker.tab.image": "Image",
	"notes.coverPicker.tab.gallery": "Color",
	"notes.coverPicker.tab.reposition": "Reposition",
	"notes.coverPicker.upload": "Upload image",
	"notes.coverPicker.uploading": "Uploading…",
	"notes.coverPicker.dropHint": "Drag an image here, or click to browse",
	"notes.coverPicker.libraryEmpty": "No covers uploaded yet.",
	"notes.coverPicker.focalHint": "Drag to choose the focal point.",
	"notes.coverPicker.useCover": "Use cover",
	"notes.coverPicker.galleryRegion": "Gradient and colour covers",
};

export type TranslationParams = Record<string, string | number>;

// Lookup + `{param}` interpolation come from the shared SDK primitive
// (`@brainstorm/sdk/i18n`) — there is exactly one app-side `t()`
// implementation now, not a per-app re-roll. Notes keeps a thin wrapper
// only for its dev-time missing-key signal (the SDK falls back to the
// raw key; Notes wants a loud warning + a visible `[?key]` sentinel so a
// dropped string can't slip through a screenshot review).
const translate = createT(DEFAULTS);

export function t(key: string, params?: TranslationParams): string {
	if (!Object.hasOwn(DEFAULTS, key)) {
		if (typeof process !== "undefined" && process.env?.NODE_ENV !== "production") {
			console.warn(`[notes/i18n] missing translation key: ${key}`);
		}
		return `[?${key}]`;
	}
	return translate(key, params);
}

/** Pick the singular or plural form based on count. Tiny English-only
 *  ruleset (one for exactly 1, otherwise other). When the locale layer
 *  arrives this delegates to `Intl.PluralRules`. */
export function tCount(baseKey: string, count: number): string {
	const suffix = count === 1 ? "one" : "other";
	return t(`${baseKey}.${suffix}`, { count });
}
