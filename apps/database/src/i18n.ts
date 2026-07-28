/**
 * App-side translations per
 * §Localization — the shared `@brainstorm-os/sdk/i18n` `createT` (`{name}`
 * interpolation only, no ICU). The English catalog lives in `./i18n/en.json`
 * (the source language per the manifest `i18n` block); overlay packs are
 * code-split per locale and swapped in by `./i18n-boot`.
 */

import {
	type LocalePackImporters,
	type TFunction,
	type TParams,
	createT,
	plural as sdkPlural,
} from "@brainstorm-os/sdk/i18n";
import enCatalog from "./i18n/en.json";

export const DATABASE_I18N = enCatalog as typeof enCatalog;

export type DatabaseManifest = typeof DATABASE_I18N;
export type TranslationKey = keyof DatabaseManifest;

/** Lazy overlay packs — code-split per locale (12.15 slice 15d). */
export const LOCALE_PACK_IMPORTERS: LocalePackImporters<DatabaseManifest> = {
	es: () => import("./i18n/es.json"),
	de: () => import("./i18n/de.json"),
	fr: () => import("./i18n/fr.json"),
	it: () => import("./i18n/it.json"),
	pt: () => import("./i18n/pt.json"),
};

let activeT: TFunction<DatabaseManifest> = createT(DATABASE_I18N);

/** Imperative surfaces read the latest reactive `t` (swapped by `i18n-boot`). */
export function syncActiveTranslator(next: TFunction<DatabaseManifest>): void {
	activeT = next;
}

export function t(key: TranslationKey, params?: TParams): string {
	return activeT(key, params);
}

/** Non-React tests and standalone previews use the English manifest. */
export const englishT = createT(DATABASE_I18N);

/** Catalog-bound plural — picks `<base>.one` / `<base>.other`. The
 *  `count === 1` selection lives in the shared helper, never in component
 *  code (per §Localization). */
export const plural = (
	count: number,
	oneKey: TranslationKey,
	otherKey: TranslationKey,
	params?: TParams,
): string => sdkPlural(activeT, count, oneKey, otherKey, params);
