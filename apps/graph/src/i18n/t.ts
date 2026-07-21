/**
 * The Graph app's bound `t()` — the single translation entry point for
 * every JS-built user-visible string. Wraps the shared
 * `@brainstorm-os/sdk/i18n` `createT` over the local English manifest, so the
 * Graph app uses the *same* interpolation + missing-key semantics every
 * other app does (shared-fundamentals contract §C).
 *
 * A locale override layer can be threaded in later by passing a second
 * argument to `createT`; v1 ships English-only like its sibling apps.
 */

import { type TParams, createT, plural as sdkPlural } from "@brainstorm-os/sdk/i18n";
import { GRAPH_I18N, type GraphI18nKey } from "./manifest";

export const t = createT(GRAPH_I18N);

/** Catalog-bound plural — picks `<one>` / `<other>` via the shared SDK
 *  helper so the `count === 1` selection never lives in component code
 *  (CLAUDE.md §Localization). */
export function plural(
	count: number,
	oneKey: GraphI18nKey,
	otherKey: GraphI18nKey,
	params?: TParams,
): string {
	return sdkPlural(t, count, oneKey, otherKey, params);
}
