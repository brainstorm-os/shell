/**
 * Agent app i18n manifest. Per
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

export const AGENT_I18N = enCatalog as typeof enCatalog;

export type AgentI18nKey = keyof typeof AGENT_I18N;

/** Lazy overlay packs — code-split per locale (12.15 slice 15c). */
export const LOCALE_PACK_IMPORTERS: LocalePackImporters<typeof AGENT_I18N> = {
	es: () => import("./i18n/es.json"),
};

let activeT: TFunction<typeof AGENT_I18N> = createT(AGENT_I18N);

/** Imperative surfaces read the latest reactive `t`. */
export function syncActiveTranslator(next: TFunction<typeof AGENT_I18N>): void {
	activeT = next;
}

export function t(key: AgentI18nKey, params?: TParams): string {
	return activeT(key, params);
}

/** Non-React tests and standalone previews use the English manifest. */
export const englishT = createT(AGENT_I18N);

export const plural = (
	count: number,
	oneKey: AgentI18nKey,
	otherKey: AgentI18nKey,
	params?: TParams,
): string => sdkPlural(activeT, count, oneKey, otherKey, params);
