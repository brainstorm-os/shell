/**
 * App-side translations per
 * §Localization and.
 *
 * `t` is produced by the shared `@brainstorm-os/sdk/i18n` `createT` (the B-2
 * app-side `t()`): call sites depend on the **id**, the default-English
 * manifest fills in until the locale layer (Stage 12) lands, and overlay
 * packs merge per-locale partials at runtime. The `brainstorm.files.*` id
 * namespace mirrors what manager-ux.md §Localization enumerates.
 */

import {
	type LocalePackImporters,
	type TFunction,
	type TParams,
	createT,
	plural as sdkPlural,
} from "@brainstorm-os/sdk/i18n";
import enCatalog from "./i18n/en.json";

export const DEFAULTS = enCatalog as typeof enCatalog;

export type FilesManifest = typeof DEFAULTS;
export type TranslationKey = keyof FilesManifest;

/** Lazy overlay packs — code-split per locale (12.15 slice 15c). */
export const LOCALE_PACK_IMPORTERS: LocalePackImporters<FilesManifest> = {
	es: () => import("./i18n/es.json"),
};

let activeT: TFunction<FilesManifest> = createT(DEFAULTS);

/** Imperative surfaces read the latest reactive `t`. */
export function syncActiveTranslator(next: TFunction<FilesManifest>): void {
	activeT = next;
}

export function t(key: TranslationKey, params?: TParams): string {
	return activeT(key, params);
}

/** Catalog-bound plural — keeps keys typed to `FilesManifest` (unlike raw sdk `plural` + app `t`). */
export function plural(
	count: number,
	oneKey: TranslationKey,
	otherKey: TranslationKey,
	params?: TParams,
): string {
	return sdkPlural(activeT, count, oneKey, otherKey, params);
}

/** Non-React tests and standalone previews use the English manifest. */
export const englishT = createT(DEFAULTS);

/** Test helper for assertions over the default manifest. Not exported via a
 *  public surface; tests import directly. */
export function _defaultsForTesting(): Readonly<FilesManifest> {
	return DEFAULTS;
}
