/**
 * Form Designer app i18n manifest. Per
 * §Localization every user-visible string flows through the shared app-side
 * `t()` (`createT` from `@brainstorm/sdk/i18n` — `{name}` interpolation only,
 * no ICU) — no bare literals.
 */

import {
	type LocalePackImporters,
	type TFunction,
	type TParams,
	createT,
	plural as sdkPlural,
} from "@brainstorm/sdk/i18n";
import enCatalog from "./i18n/en.json";

export const FORM_DESIGNER_I18N = enCatalog as typeof enCatalog;

export type FormDesignerI18nKey = keyof typeof FORM_DESIGNER_I18N;

/** Lazy overlay packs — code-split per locale (12.15 slice 15c). */
export const LOCALE_PACK_IMPORTERS: LocalePackImporters<typeof FORM_DESIGNER_I18N> = {
	es: () => import("./i18n/es.json"),
};

let activeT: TFunction<typeof FORM_DESIGNER_I18N> = createT(FORM_DESIGNER_I18N);

/** Imperative surfaces read the latest reactive `t`. */
export function syncActiveTranslator(next: TFunction<typeof FORM_DESIGNER_I18N>): void {
	activeT = next;
}

export function t(key: FormDesignerI18nKey, params?: TParams): string {
	return activeT(key, params);
}

/** Non-React tests and standalone previews use the English manifest. */
export const englishT = createT(FORM_DESIGNER_I18N);

export function plural(count: number, one: FormDesignerI18nKey, other: FormDesignerI18nKey): string {
	return sdkPlural(activeT, count, one, other);
}
