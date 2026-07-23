/**
 * Contacts app i18n manifest. Per
 * §Localization every user-visible string flows through the shared app-side
 * `t()` (`createT` from `@brainstorm-os/sdk/i18n`) — no bare literals. The
 * app-side `t()` does `{name}` interpolation only (no ICU plurals — that is
 * the renderer catalog's job), so count-sensitive copy is split into
 * semantic keys (today / tomorrow / future) rather than a plural rule.
 */

import {
	type LocalePackImporters,
	type TFunction,
	type TParams,
	createT,
	plural as sdkPlural,
} from "@brainstorm-os/sdk/i18n";
import enCatalog from "./i18n/en.json";

export const CONTACTS_I18N = enCatalog as typeof enCatalog;

export type ContactsI18nKey = keyof typeof CONTACTS_I18N;

/** Lazy overlay packs — code-split per locale (12.15 slice 15c). */
export const LOCALE_PACK_IMPORTERS: LocalePackImporters<typeof CONTACTS_I18N> = {
	es: () => import("./i18n/es.json"),
	de: () => import("./i18n/de.json"),
	fr: () => import("./i18n/fr.json"),
	it: () => import("./i18n/it.json"),
	pt: () => import("./i18n/pt.json"),
};

let activeT: TFunction<typeof CONTACTS_I18N> = createT(CONTACTS_I18N);

/** Imperative surfaces read the latest reactive `t`. */
export function syncActiveTranslator(next: TFunction<typeof CONTACTS_I18N>): void {
	activeT = next;
}

export function t(key: ContactsI18nKey, params?: TParams): string {
	return activeT(key, params);
}

/** Non-React tests and standalone previews use the English manifest. */
export const englishT = createT(CONTACTS_I18N);

export const plural = (
	count: number,
	oneKey: ContactsI18nKey,
	otherKey: ContactsI18nKey,
	params?: TParams,
): string => sdkPlural(activeT, count, oneKey, otherKey, params);
