/**
 * Web Browser app i18n manifest. Per
 * §Localization every user-visible string flows through the shared app-side
 * `t()` (`createT` from `@brainstorm-os/sdk/i18n`) — no bare literals.
 */

import {
	type LocalePackImporters,
	type TFunction,
	type TParams,
	createT,
	plural as sdkPlural,
} from "@brainstorm-os/sdk/i18n";
import enCatalog from "./i18n/en.json";

export const BROWSER_I18N = enCatalog as typeof enCatalog;

export type BrowserI18nKey = keyof typeof BROWSER_I18N;

/** Lazy overlay packs — code-split per locale (12.15 slice 15c). */
export const LOCALE_PACK_IMPORTERS: LocalePackImporters<typeof BROWSER_I18N> = {
	es: () => import("./i18n/es.json"),
};

let activeT: TFunction<typeof BROWSER_I18N> = createT(BROWSER_I18N);

/** Imperative surfaces read the latest reactive `t`. */
export function syncActiveTranslator(next: TFunction<typeof BROWSER_I18N>): void {
	activeT = next;
}

export function t(key: BrowserI18nKey, params?: TParams): string {
	return activeT(key, params);
}

/** Non-React tests and standalone previews use the English manifest. */
export const englishT = createT(BROWSER_I18N);

/** Catalog-bound plural — picks `<base>.one` / `<base>.other`. See the SDK
 *  `plural` doc: the count selection lives in the shared helper, not here. */
export const plural = (
	count: number,
	oneKey: BrowserI18nKey,
	otherKey: BrowserI18nKey,
	params?: TParams,
): string => sdkPlural(activeT, count, oneKey, otherKey, params);
