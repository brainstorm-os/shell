/**
 * The Book property bridge for the shared inspector — synthesises the
 * `PropertyDef[]` + values the SHARED property-value cells render
 * (`@brainstorm-os/sdk/properties-panel`), mirroring the Contacts / Bookmarks
 * bridges. Author writes back as an entity patch; format / pages / progress
 * are derived read-only facts (progress is owned by the reader's
 * position-persistence path, never edited by hand).
 */

import { type PropertyDef, PropertyView, ValueType } from "@brainstorm-os/sdk-types";
import { t } from "../i18n";
import { type Book, BookFormat } from "../types/book";

export const BOOK_PROP_KEY = {
	author: "author",
	format: "format",
	pages: "pages",
	progress: "progress",
} as const;

export function bookPropertyDefs(): readonly PropertyDef[] {
	return [
		{ key: BOOK_PROP_KEY.author, name: t("prop.author"), icon: null, valueType: ValueType.Text },
		{ key: BOOK_PROP_KEY.format, name: t("prop.format"), icon: null, valueType: ValueType.Text },
		{ key: BOOK_PROP_KEY.pages, name: t("prop.pages"), icon: null, valueType: ValueType.Number },
		{
			key: BOOK_PROP_KEY.progress,
			name: t("prop.progress"),
			icon: null,
			valueType: ValueType.Number,
			display: { view: PropertyView.ProgressBar },
		},
	];
}

export const READONLY_BOOK_PROP_KEYS: ReadonlySet<string> = new Set([
	BOOK_PROP_KEY.format,
	BOOK_PROP_KEY.pages,
	BOOK_PROP_KEY.progress,
]);

const FORMAT_LABEL_KEYS = {
	[BookFormat.Pdf]: "prop.format.pdf",
	[BookFormat.Epub]: "prop.format.epub",
} as const;

/** Cell values for a book. Progress is 0..100 (the ProgressBar cell's
 *  default range). */
export function bookToValues(book: Book): Record<string, unknown> {
	return {
		[BOOK_PROP_KEY.author]: book.author,
		[BOOK_PROP_KEY.format]: t(FORMAT_LABEL_KEYS[book.format]),
		[BOOK_PROP_KEY.pages]: book.spineLength > 0 ? book.spineLength : null,
		[BOOK_PROP_KEY.progress]: Math.round(book.reading.progress * 100),
	};
}

/** Map an edited cell value back to an entity property patch; `null` for
 *  read-only keys. */
export function applyBookPropertyValue(key: string, next: unknown): Record<string, unknown> | null {
	if (key === BOOK_PROP_KEY.author) {
		return { author: typeof next === "string" ? next.trim() : "" };
	}
	return null;
}
