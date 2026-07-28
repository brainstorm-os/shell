/**
 * Journal app i18n manifest + `t()`. Built on the shared SDK `createT`
 * (`@brainstorm-os/sdk/i18n`) so every user-visible string flows through one
 * typed lookup with `{name}` interpolation — no bare literals in components.
 *
 * English defaults live in the extracted catalog (`../i18n/en.json`);
 * per-locale overlay packs are lazy-loaded (12.15 slice 15d). Pluralisation
 * that depends on a count (word / words) is two manifest keys selected via
 * `journalPlural`, matching the shell's `t.ts` convention (no embedded ICU
 * plural in v1).
 */

import {
	type LocalePackImporters,
	type TFunction,
	type TParams,
	createT,
	plural as sdkPlural,
} from "@brainstorm-os/sdk/i18n";
import enCatalog from "../i18n/en.json";

export const JOURNAL_I18N = enCatalog as typeof enCatalog;

/** The frozen set of Journal string ids, derived from the catalog. */
export type JournalI18nKey = keyof typeof JOURNAL_I18N;

export type JournalManifest = Record<JournalI18nKey, string>;

/** Lazy overlay packs — code-split per locale (12.15 slice 15c). */
export const LOCALE_PACK_IMPORTERS: LocalePackImporters<JournalManifest> = {
	es: () => import("../i18n/es.json"),
	de: () => import("../i18n/de.json"),
	fr: () => import("../i18n/fr.json"),
	it: () => import("../i18n/it.json"),
	pt: () => import("../i18n/pt.json"),
};

export type JournalT = TFunction<JournalManifest>;

let activeT: JournalT = createT(JOURNAL_I18N);

/** Imperative surfaces read the latest reactive `t`. */
export function syncActiveTranslator(next: JournalT): void {
	activeT = next;
}

export function t(key: JournalI18nKey, params?: TParams): string {
	return activeT(key, params);
}

/** Tests and standalone previews build a fixed `t` (English defaults plus an
 *  optional `Partial<…>` override layer). */
export function buildJournalT(overrides?: Partial<JournalManifest>): JournalT {
	return createT(JOURNAL_I18N, overrides);
}

/** Catalog-bound plural — picks `<base>One` / `<base>Other` (or the explicit
 *  key pair) and lets the shared helper own the `count === 1` selection. See
 *  the SDK `plural` doc: the count branch lives here, never in component code. */
export function journalPlural(
	t: JournalT,
	count: number,
	oneKey: JournalI18nKey,
	otherKey: JournalI18nKey,
	params?: TParams,
): string {
	return sdkPlural<JournalManifest>(t, count, oneKey, otherKey, params);
}
