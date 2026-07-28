/**
 * Graph app i18n manifest — every user-visible string the renderer builds
 * in JS (textContent / title / aria-label / status pill / cycle-button
 * labels). Per ` §Localization` and
 * the shared-fundamentals contract §C: no bare literal in app logic; the
 * default-English catalog lives in `./en.json` and every site goes through
 * `t()` from `./t`. Per-locale overlay packs load lazily through
 * `LOCALE_PACK_IMPORTERS` (12.15 slice 15d).
 *
 * Static markup in `index.html` is the shell-templated chrome and is not
 * JS-built; it is out of this module's surface (it would need a separate
 * static-DOM pass) and is tracked in the app-completion matrix, not here.
 *
 * Keys are dotted by region (`pattern.*`, `export.*`, `local.*`,
 * `status.*`) so the catalog stays grepable as it grows. `{name}`-style
 * params interpolate via `createT`.
 */

import type { LocalePackImporters } from "@brainstorm-os/sdk/i18n";
import enCatalog from "./en.json";

export const GRAPH_I18N = enCatalog as typeof enCatalog;

export type GraphI18nKey = keyof typeof GRAPH_I18N;

/** Lazy overlay packs — code-split per locale. */
export const LOCALE_PACK_IMPORTERS: LocalePackImporters<typeof GRAPH_I18N> = {
	es: () => import("./es.json"),
	de: () => import("./de.json"),
	fr: () => import("./fr.json"),
	it: () => import("./it.json"),
	pt: () => import("./pt.json"),
};
