/**
 * Whiteboard-app translate function — a thin binding over the shared
 * `@brainstorm-os/sdk/i18n` `createT` (B-2 landed; the per-app hand-rolled
 * `t()` is retired per the shared-fundamentals contract §C). The app owns
 * only its English catalog (`./en.json`, the source language per the
 * manifest `i18n` block); lookup, `{param}` interpolation and the
 * missing-key fallback are the SDK's. Every user-visible string wraps in
 * `t(key)` per CLAUDE.md §Localization.
 */

import {
	type LocalePackImporters,
	type TFunction,
	type TParams,
	createT as sdkCreateT,
} from "@brainstorm-os/sdk/i18n";
import enCatalog from "./en.json";

export const WHITEBOARD_MANIFEST = enCatalog as typeof enCatalog;

export type WhiteboardMessageKey = keyof typeof WHITEBOARD_MANIFEST;
export type TranslationParams = TParams;

/** Lazy overlay packs — code-split per locale (12.15 slice 15d). */
export const LOCALE_PACK_IMPORTERS: LocalePackImporters<typeof WHITEBOARD_MANIFEST> = {
	es: () => import("./es.json"),
	de: () => import("./de.json"),
	fr: () => import("./fr.json"),
	it: () => import("./it.json"),
	pt: () => import("./pt.json"),
};

let activeT: TFunction<typeof WHITEBOARD_MANIFEST> = sdkCreateT(WHITEBOARD_MANIFEST);

/** Imperative surfaces read the latest reactive `t`. */
export function syncActiveTranslator(next: TFunction<typeof WHITEBOARD_MANIFEST>): void {
	activeT = next;
}

export function t(key: WhiteboardMessageKey, params?: TParams): string {
	return activeT(key, params);
}

/** Non-React tests and standalone previews use the English manifest. */
export const englishT = sdkCreateT(WHITEBOARD_MANIFEST);

/** Build an app-scoped `t()` over the English catalog plus `overrides` —
 *  the pack-free path unit tests drive directly. */
export function createT(
	overrides?: Partial<Record<WhiteboardMessageKey, string>>,
): (key: WhiteboardMessageKey, params?: TParams) => string {
	return sdkCreateT(WHITEBOARD_MANIFEST, overrides);
}

/** Catalog-bound plural — picks `<base>.one` / `<base>.other`. The count
 *  selection lives in the shared SDK helper, never in component code
 *  (CLAUDE.md §Localization). */
export function pluralWith(
	t: (key: WhiteboardMessageKey, params?: TParams) => string,
	count: number,
	oneKey: WhiteboardMessageKey,
	otherKey: WhiteboardMessageKey,
	params?: TParams,
): string {
	// The sanctioned home for the `count === 1` branch (CLAUDE.md
	// §Localization) — never in component code.
	return t(count === 1 ? oneKey : otherKey, { count, ...params });
}
