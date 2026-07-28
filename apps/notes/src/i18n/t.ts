/**
 * Notes-app translate function. Built on the shared SDK `createT`
 * (`@brainstorm-os/sdk/i18n`): id-keyed lookups against the extracted
 * English catalog (`./en.json`), `{param}` interpolation, lazy per-locale
 * overlay packs (12.15 slice 15d).
 *
 * Per CLAUDE.md §Localization: every user-visible string wraps in
 * `t(key)` — including screen-reader strings inside `aria-live` regions,
 * even though they aren't visually rendered.
 */

import { type LocalePackImporters, type TFunction, createT } from "@brainstorm-os/sdk/i18n";
import enCatalog from "./en.json";

export const NOTES_I18N = enCatalog as typeof enCatalog;

export type NotesI18nKey = keyof typeof NOTES_I18N;

/** Lazy overlay packs — code-split per locale (12.15 slice 15c). */
export const LOCALE_PACK_IMPORTERS: LocalePackImporters<typeof NOTES_I18N> = {
	es: () => import("./es.json"),
	de: () => import("./de.json"),
	fr: () => import("./fr.json"),
	it: () => import("./it.json"),
	pt: () => import("./pt.json"),
};

export type TranslationParams = Record<string, string | number>;

let activeT: TFunction<typeof NOTES_I18N> = createT(NOTES_I18N);

/** Imperative surfaces read the latest reactive `t`. */
export function syncActiveTranslator(next: TFunction<typeof NOTES_I18N>): void {
	activeT = next;
}

// Notes keeps a thin wrapper over the SDK `t` only for its dev-time
// missing-key signal (the SDK falls back to the raw key; Notes wants a loud
// warning + a visible `[?key]` sentinel so a dropped string can't slip
// through a screenshot review).
export function t(key: string, params?: TranslationParams): string {
	if (!Object.hasOwn(NOTES_I18N, key)) {
		if (typeof process !== "undefined" && process.env?.NODE_ENV !== "production") {
			console.warn(`[notes/i18n] missing translation key: ${key}`);
		}
		return `[?${key}]`;
	}
	return activeT(key as NotesI18nKey, params);
}

/** Non-React tests and standalone previews use the English manifest. */
export const englishT = createT(NOTES_I18N);

/** Pick the singular or plural form based on count. The `count === 1`
 *  selection lives here (the sanctioned place), never in component code. */
export function tCount(baseKey: string, count: number, params?: TranslationParams): string {
	const suffix = count === 1 ? "one" : "other";
	return t(`${baseKey}.${suffix}`, { count, ...params });
}
