/**
 * Baseline editor theme — maps Lexical node types to stable CSS class
 * names under the `bs-editor__*` namespace. Generalises the Notes-app
 * theme (`notes__*`) so every app's rich text renders consistently; the
 * shell's flattened design tokens style these classes (per
 * [[apps-inherit-shell-theme]]). Apps merge overrides via `mergeTheme`.
 */

import type { EditorThemeClasses } from "lexical";

export const baselineTheme: EditorThemeClasses = {
	paragraph: "bs-editor__paragraph",
	heading: {
		h1: "bs-editor__h1",
		h2: "bs-editor__h2",
		h3: "bs-editor__h3",
	},
	quote: "bs-editor__quote",
	list: {
		ul: "bs-editor__list bs-editor__list--bullet",
		ol: "bs-editor__list bs-editor__list--numbered",
		checklist: "bs-editor__list--check",
		listitem: "bs-editor__list-item",
		listitemChecked: "bs-editor__list-item bs-editor__list-item--checked",
		listitemUnchecked: "bs-editor__list-item bs-editor__list-item--unchecked",
		nested: { listitem: "bs-editor__list-item--nested" },
	},
	text: {
		bold: "bs-editor__text--bold",
		italic: "bs-editor__text--italic",
		underline: "bs-editor__text--underline",
		strikethrough: "bs-editor__text--strike",
		code: "bs-editor__text--code",
	},
	code: "bs-editor__code",
	link: "bs-editor__link",
	image: "bs-editor__image",
};

/**
 * The full rich-text theme — maps Lexical built-in node types to the
 * `notes__*` class names that `@brainstorm-os/editor/editor-theme.css`
 * styles (and that the shared custom nodes — callout / toggle / mention /
 * transclusion — already emit). Every surface that mounts the full editor
 * (`<FullEditorPlugins>` + `editor-theme.css`) passes this as
 * `<BrainstormEditor theme>` so built-in blocks (paragraph / heading /
 * list / quote / code / table) render with the SAME styling as the custom
 * blocks instead of falling back to the unstyled `bs-editor__*` baseline.
 *
 * (The `notes__*` prefix is historical — the class rename to `bs-editor__*`
 * is a separate mechanical cleanup; what matters is that theme + CSS +
 * node classes all agree on ONE namespace.)
 */
export const richTextTheme: EditorThemeClasses = {
	paragraph: "notes__paragraph",
	heading: {
		h1: "notes__h1",
		h2: "notes__h2",
		h3: "notes__h3",
	},
	quote: "notes__quote",
	list: {
		ul: "notes__list notes__list--bullet",
		ol: "notes__list notes__list--numbered",
		listitem: "notes__list-item",
		listitemChecked: "notes__list-item notes__list-item--checked",
		listitemUnchecked: "notes__list-item notes__list-item--unchecked",
		nested: { listitem: "notes__list-item--nested" },
	},
	text: {
		bold: "notes__text--bold",
		italic: "notes__text--italic",
		underline: "notes__text--underline",
		strikethrough: "notes__text--strike",
		code: "notes__text--code",
	},
	code: "notes__code",
	link: "notes__link",
	table: "notes__table",
	tableRow: "notes__table-row",
	tableCell: "notes__table-cell",
	tableCellHeader: "notes__table-cell--header",
	tableSelected: "notes__table--selected",
	tableCellSelected: "notes__table-cell--selected",
};

/** Shallow-merge a theme override onto the baseline, merging the one-level
 *  nested maps (`heading`, `list`, `text`, `list.nested`) so an app can
 *  override `text.bold` without dropping the rest of the baseline. */
export function mergeTheme(override?: EditorThemeClasses): EditorThemeClasses {
	if (!override) return baselineTheme;
	const merged: EditorThemeClasses = { ...baselineTheme, ...override };
	for (const key of ["heading", "list", "text"] as const) {
		const base = baselineTheme[key];
		const over = override[key];
		if (base && over && typeof base === "object" && typeof over === "object") {
			merged[key] = { ...base, ...over } as never;
		}
	}
	return merged;
}
