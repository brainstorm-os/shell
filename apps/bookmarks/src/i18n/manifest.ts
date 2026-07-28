/**
 * Bookmarks app i18n manifest — every user-visible string the renderer
 * emits, keyed and English-defaulted, consumed through the shared
 * `@brainstorm-os/sdk/i18n` `createT`. The English catalog lives in
 * `./en.json`; per-locale overlay packs load lazily through
 * `LOCALE_PACK_IMPORTERS`. Missing keys degrade to the English default
 * (never a crash) per the shared `t()` contract.
 *
 * No bare string literal may reach the DOM — it goes through a key here.
 */

import {
	type LocalePackImporters,
	type TFunction,
	type TParams,
	createT,
	plural as sdkPlural,
} from "@brainstorm-os/sdk/i18n";
import enCatalog from "./en.json";

export const BOOKMARKS_MESSAGES = enCatalog as typeof enCatalog;

export type BookmarksMessages = typeof BOOKMARKS_MESSAGES;
export type BookmarksMessageKey = keyof BookmarksMessages;

/** Lazy overlay packs — code-split per locale (12.15 slice 15d). */
export const LOCALE_PACK_IMPORTERS: LocalePackImporters<BookmarksMessages> = {
	es: () => import("./es.json"),
	de: () => import("./de.json"),
	fr: () => import("./fr.json"),
	it: () => import("./it.json"),
	pt: () => import("./pt.json"),
};

let activeT: TFunction<BookmarksMessages> = createT(BOOKMARKS_MESSAGES);

/** Imperative surfaces read the latest reactive `t`. */
export function syncActiveTranslator(next: TFunction<BookmarksMessages>): void {
	activeT = next;
}

/** The app-wide `t`. */
export function t(key: BookmarksMessageKey, params?: TParams): string {
	return activeT(key, params);
}

/** Non-React tests and standalone previews use the English manifest. */
export const englishT = createT(BOOKMARKS_MESSAGES);

/** Catalog-bound plural — picks `<base>.one` / `<base>.many`. The count
 *  selection lives in the shared helper, not in component code. */
export const plural = (
	count: number,
	oneKey: BookmarksMessageKey,
	otherKey: BookmarksMessageKey,
	params?: TParams,
): string => sdkPlural(activeT, count, oneKey, otherKey, params);
