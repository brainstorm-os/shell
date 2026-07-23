/**
 * Preview app i18n manifest. Per
 * §Localization every user-visible string flows through the shared
 * app-side `t()` (`createT` from `@brainstorm-os/sdk/i18n`) over this
 * default-English manifest — no bare literals in app.ts / inspector.ts.
 *
 * `{name}` placeholders are interpolated by `createT`. Keys are stable
 * identifiers; overlay packs supply per-locale partials merged at runtime.
 */

import {
	type LocalePackImporters,
	type TFunction,
	type TParams,
	createT,
	plural as sdkPlural,
} from "@brainstorm-os/sdk/i18n";
import enCatalog from "./i18n/en.json";

export const PREVIEW_I18N = enCatalog as typeof enCatalog;

export type PreviewI18nKey = keyof typeof PREVIEW_I18N;

/** Lazy overlay packs — code-split per locale (12.15 slice 15c). */
export const LOCALE_PACK_IMPORTERS: LocalePackImporters<typeof PREVIEW_I18N> = {
	es: () => import("./i18n/es.json"),
	de: () => import("./i18n/de.json"),
	fr: () => import("./i18n/fr.json"),
	it: () => import("./i18n/it.json"),
	pt: () => import("./i18n/pt.json"),
};

let activeT: TFunction<typeof PREVIEW_I18N> = createT(PREVIEW_I18N);

/** Imperative surfaces read the latest reactive `t`. */
export function syncActiveTranslator(next: TFunction<typeof PREVIEW_I18N>): void {
	activeT = next;
}

export function t(key: PreviewI18nKey, params?: TParams): string {
	return activeT(key, params);
}

/** Non-React tests and standalone previews use the English manifest. */
export const englishT = createT(PREVIEW_I18N);

/** Catalog-bound plural — picks `<base>.one` / `<base>.other`. The count
 *  selection lives in the shared SDK helper, never in component code. */
export const plural = (
	count: number,
	oneKey: PreviewI18nKey,
	otherKey: PreviewI18nKey,
	params?: TParams,
): string => sdkPlural(activeT, count, oneKey, otherKey, params);
