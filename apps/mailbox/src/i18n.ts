/**
 * Mailbox app i18n manifest. Per
 * §Localization every user-visible string flows through the shared app-side
 * `t()` (`createT` from `@brainstorm/sdk/i18n`) — no bare literals. The
 * app-side `t()` does `{name}` interpolation only (no ICU plurals — that is
 * the renderer catalog's job).
 */

import {
	type LocalePackImporters,
	type TFunction,
	type TParams,
	createT,
	plural as sdkPlural,
} from "@brainstorm/sdk/i18n";
import enCatalog from "./i18n/en.json";

export const MAILBOX_I18N = enCatalog as typeof enCatalog;

export type MailboxI18nKey = keyof typeof MAILBOX_I18N;

/** Lazy overlay packs — code-split per locale (12.15 slice 15c). */
export const LOCALE_PACK_IMPORTERS: LocalePackImporters<typeof MAILBOX_I18N> = {
	es: () => import("./i18n/es.json"),
};

let activeT: TFunction<typeof MAILBOX_I18N> = createT(MAILBOX_I18N);

/** Imperative surfaces read the latest reactive `t`. */
export function syncActiveTranslator(next: TFunction<typeof MAILBOX_I18N>): void {
	activeT = next;
}

export function t(key: MailboxI18nKey, params?: TParams): string {
	return activeT(key, params);
}

/** Non-React tests and standalone previews use the English manifest. */
export const englishT = createT(MAILBOX_I18N);

export const plural = (
	count: number,
	oneKey: MailboxI18nKey,
	otherKey: MailboxI18nKey,
	params?: TParams,
): string => sdkPlural(activeT, count, oneKey, otherKey, params);
