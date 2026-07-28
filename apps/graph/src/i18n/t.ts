/**
 * The Graph app's bound `t()` — the single translation entry point for
 * every JS-built user-visible string. Wraps the shared
 * `@brainstorm-os/sdk/i18n` `createT` over the local English catalog, so the
 * Graph app uses the *same* interpolation + missing-key semantics every
 * other app does (shared-fundamentals contract §C). The React provider
 * (`../i18n-provider`) swaps in the locale-overlaid translator via
 * `syncActiveTranslator`, so imperative surfaces (canvas controller,
 * renderers) read the live locale too.
 */

import {
	type TFunction,
	type TParams,
	createT,
	plural as sdkPlural,
} from "@brainstorm-os/sdk/i18n";
import { GRAPH_I18N, type GraphI18nKey } from "./manifest";

let activeT: TFunction<typeof GRAPH_I18N> = createT(GRAPH_I18N);

/** Imperative surfaces read the latest reactive `t`. */
export function syncActiveTranslator(next: TFunction<typeof GRAPH_I18N>): void {
	activeT = next;
}

export function t(key: GraphI18nKey, params?: TParams): string {
	return activeT(key, params);
}

/** Non-React tests and standalone previews use the English manifest. */
export const englishT = createT(GRAPH_I18N);

/** Catalog-bound plural — picks `<one>` / `<other>` via the shared SDK
 *  helper so the `count === 1` selection never lives in component code
 *  (CLAUDE.md §Localization). */
export function plural(
	count: number,
	oneKey: GraphI18nKey,
	otherKey: GraphI18nKey,
	params?: TParams,
): string {
	return sdkPlural(activeT, count, oneKey, otherKey, params);
}
