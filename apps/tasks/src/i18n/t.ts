/**
 * Tasks-app translate function. Built on the shared `@brainstorm-os/sdk/i18n`
 * `createT` (the app-side `t()` per the shared-fundamentals contract §C) —
 * this module owns only the English catalog import + a dev missing-key
 * warning + the tiny plural switch; the lookup/interpolation is the SDK's.
 * Overlay packs load lazily per locale (12.15 slice 15d).
 */

import { type LocalePackImporters, type TFunction, createT } from "@brainstorm-os/sdk/i18n";
import enCatalog from "./en.json";

export const TASKS_I18N = enCatalog as typeof enCatalog;

export type TranslationKey = keyof typeof TASKS_I18N;
export type TranslationParams = Record<string, string | number>;

/** Lazy overlay packs — code-split per locale (12.15 slice 15d). */
export const LOCALE_PACK_IMPORTERS: LocalePackImporters<typeof TASKS_I18N> = {
	es: () => import("./es.json"),
	de: () => import("./de.json"),
	fr: () => import("./fr.json"),
	it: () => import("./it.json"),
	pt: () => import("./pt.json"),
};

let activeT: TFunction<typeof TASKS_I18N> = createT(TASKS_I18N);

/** Imperative surfaces read the latest reactive `t`. */
export function syncActiveTranslator(next: TFunction<typeof TASKS_I18N>): void {
	activeT = next;
}

/** Non-React tests and standalone previews use the English manifest. */
export const englishT = createT(TASKS_I18N);

const KNOWN_KEYS = new Set(Object.keys(TASKS_I18N));

export function t(key: string, params?: TranslationParams): string {
	if (!KNOWN_KEYS.has(key)) {
		if (typeof process !== "undefined" && process.env?.NODE_ENV !== "production") {
			console.warn(`[tasks/i18n] missing translation key: ${key}`);
		}
		return `[?${key}]`;
	}
	return activeT(key as TranslationKey, params);
}

/** Tiny plural switch (zero / one / other) over `<base>.<suffix>` catalog keys —
 *  the ONE sanctioned count selection (per CLAUDE.md app-side plural rule). */
export function tCount(baseKey: string, count: number): string {
	const suffix = count === 0 ? "zero" : count === 1 ? "one" : "other";
	return t(`${baseKey}.${suffix}`, { count });
}
