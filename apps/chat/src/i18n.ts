/**
 * Chat app i18n manifest. Per
 * §Localization every user-visible string flows through the shared app-side
 * `t()` (`createT` from `@brainstorm-os/sdk/i18n`) — no bare literals. `createT`
 * does `{name}` interpolation only (no ICU); plurals go through the shared
 * `plural` helper against two catalog keys.
 */

import {
	type LocalePackImporters,
	type TFunction,
	type TParams,
	createT,
	plural as sdkPlural,
} from "@brainstorm-os/sdk/i18n";
import enCatalog from "./i18n/en.json";

export const CHAT_I18N = enCatalog as typeof enCatalog;

export type ChatMessageId = keyof typeof CHAT_I18N;

/** Lazy overlay packs — code-split per locale (12.15 slice 15c). */
export const LOCALE_PACK_IMPORTERS: LocalePackImporters<typeof CHAT_I18N> = {
	es: () => import("./i18n/es.json"),
};

let activeT: TFunction<typeof CHAT_I18N> = createT(CHAT_I18N);

/** Imperative surfaces read the latest reactive `t`. */
export function syncActiveTranslator(next: TFunction<typeof CHAT_I18N>): void {
	activeT = next;
}

export function t(key: ChatMessageId, params?: TParams): string {
	return activeT(key, params);
}

/** Non-React tests and standalone previews use the English manifest. */
export const englishT = createT(CHAT_I18N);

export function plural(count: number, one: ChatMessageId, other: ChatMessageId): string {
	return sdkPlural(activeT, count, one, other);
}
