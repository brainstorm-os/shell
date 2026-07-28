/**
 * Calendar-app translate function. Wraps the shared
 * `createT` from `@brainstorm-os/sdk/i18n` (the one app-side `t()` — no
 * per-app re-implementation of the lookup / `{param}` interpolation /
 * missing-key behaviour) over the English catalog in `./en.json`; overlay
 * packs load lazily per locale (12.15 slice 15d).
 */

import {
	type LocalePackImporters,
	type TFunction,
	type TParams,
	createT,
	plural as sdkPlural,
} from "@brainstorm-os/sdk/i18n";
import enCatalog from "./en.json";

export const MANIFEST = enCatalog as typeof enCatalog;

export type CalendarManifest = typeof MANIFEST;

/** A valid manifest key — use this for the type of any record whose
 *  values are passed to `t()` (view-label maps, agenda heading keys). */
export type TKey = keyof CalendarManifest;

/** Lazy overlay packs — code-split per locale (12.15 slice 15d). */
export const LOCALE_PACK_IMPORTERS: LocalePackImporters<CalendarManifest> = {
	es: () => import("./es.json"),
	de: () => import("./de.json"),
	fr: () => import("./fr.json"),
	it: () => import("./it.json"),
	pt: () => import("./pt.json"),
};

let activeT: TFunction<CalendarManifest> = createT(MANIFEST);

/** Imperative surfaces read the latest reactive `t`. */
export function syncActiveTranslator(next: TFunction<CalendarManifest>): void {
	activeT = next;
}

export function t(key: TKey, params?: TParams): string {
	return activeT(key, params);
}

/** Non-React tests and standalone previews use the English manifest. */
export const englishT = createT(MANIFEST);

/** Catalog-bound plural — the ONE sanctioned `count === 1` selection
 *  (per CLAUDE.md app-side plural rule). */
export const plural = (
	count: number,
	one: TKey,
	other: TKey,
	params?: Record<string, string | number>,
): string => sdkPlural(activeT, count, one, other, params);

export type TranslationParams = Record<string, string | number>;
