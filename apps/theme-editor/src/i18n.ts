/**
 * Theme Editor app i18n manifest. Per
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

export const THEME_EDITOR_I18N = enCatalog as typeof enCatalog;

export type ThemeEditorI18nKey = keyof typeof THEME_EDITOR_I18N;

/** Lazy overlay packs — code-split per locale (12.15 slice 15c). */
export const LOCALE_PACK_IMPORTERS: LocalePackImporters<typeof THEME_EDITOR_I18N> = {
	es: () => import("./i18n/es.json"),
	de: () => import("./i18n/de.json"),
	fr: () => import("./i18n/fr.json"),
	it: () => import("./i18n/it.json"),
	pt: () => import("./i18n/pt.json"),
};

let activeT: TFunction<typeof THEME_EDITOR_I18N> = createT(THEME_EDITOR_I18N);

/** Imperative surfaces read the latest reactive `t`. */
export function syncActiveTranslator(next: TFunction<typeof THEME_EDITOR_I18N>): void {
	activeT = next;
}

export function t(key: ThemeEditorI18nKey, params?: TParams): string {
	return activeT(key, params);
}

/** Non-React tests and standalone previews use the English manifest. */
export const englishT = createT(THEME_EDITOR_I18N);

export function plural(count: number, one: ThemeEditorI18nKey, other: ThemeEditorI18nKey): string {
	return sdkPlural(activeT, count, one, other);
}
