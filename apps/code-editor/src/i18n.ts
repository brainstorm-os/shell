/**
 * Code-Editor English string manifest + the app-side `t()`.
 *
 * Every user-visible string in the renderer flows through `t(key)` from
 * `@brainstorm/sdk/i18n` (the shared app-side translator — `{name}`
 * interpolation, override-able per locale). No bare literals in `app.ts`
 * per §Localization. Object-menu
 * chrome is localised through the same manifest where it overlaps.
 */

import {
	type LocalePackImporters,
	type TFunction,
	type TParams,
	createT,
	plural as sdkPlural,
} from "@brainstorm/sdk/i18n";
import enCatalog from "./i18n/en.json";

export const CODE_EDITOR_MESSAGES = enCatalog as typeof enCatalog;

export type CodeEditorMessageKey = keyof typeof CODE_EDITOR_MESSAGES;

/** Lazy overlay packs — code-split per locale (12.15 slice 15c). */
export const LOCALE_PACK_IMPORTERS: LocalePackImporters<typeof CODE_EDITOR_MESSAGES> = {
	es: () => import("./i18n/es.json"),
};

let activeT: TFunction<typeof CODE_EDITOR_MESSAGES> = createT(CODE_EDITOR_MESSAGES);

/** Imperative surfaces (palettes, object menu) read the latest reactive `t`. */
export function syncActiveTranslator(next: TFunction<typeof CODE_EDITOR_MESSAGES>): void {
	activeT = next;
}

export function t(key: CodeEditorMessageKey, params?: TParams): string {
	return activeT(key, params);
}

/** Non-React tests and standalone previews use the English manifest. */
export const englishT = createT(CODE_EDITOR_MESSAGES);

export const plural = (
	count: number,
	oneKey: CodeEditorMessageKey,
	otherKey: CodeEditorMessageKey,
	params?: TParams,
): string => sdkPlural(activeT, count, oneKey, otherKey, params);
