/**
 * Runtime locale-pack loader (Track A). Resolves the best available pack for a
 * requested BCP-47 tag via the shared fallback chain, lazy-imports it, and
 * applies it through `applyLocalePack` (English base + overlay, so untranslated
 * keys fall back to English).
 *
 * Packs are partial machine-translated seeds (es/de) plus the complete English
 * source; the catalog grows as community/human translations land. English needs
 * no pack — it's the base, so selecting it just resets the catalog.
 */

import { SOURCE_LANGUAGE, localeFallbackChain } from "../../shared/locale-catalog";
import { applyLocalePack } from "./t";

/** Static importer map — explicit so the bundler can code-split each pack. Add
 *  a line here when a new locale pack ships. */
const PACK_IMPORTERS: Record<string, () => Promise<{ default: Record<string, string> }>> = {
	es: () => import("./es.json"),
	de: () => import("./de.json"),
	fr: () => import("./fr.json"),
	it: () => import("./it.json"),
	pt: () => import("./pt.json"),
};

/** Resolve + apply the pack for `language`. Walks the fallback chain (e.g.
 *  `de-AT → de → en`) and loads the first pack that exists; English resets to
 *  the base. Safe to call repeatedly; a failed import falls back to English. */
export async function loadAndApplyLocale(language: string): Promise<void> {
	if (language === SOURCE_LANGUAGE) {
		applyLocalePack(SOURCE_LANGUAGE, {});
		return;
	}
	for (const candidate of localeFallbackChain(language)) {
		if (candidate === SOURCE_LANGUAGE) break;
		const importer = PACK_IMPORTERS[candidate];
		if (!importer) continue;
		try {
			const module = await importer();
			applyLocalePack(language, module.default);
			return;
		} catch (error) {
			console.warn(`[i18n] failed to load locale pack "${candidate}"`, error);
		}
	}
	// No pack available for any chain entry — stay on English.
	applyLocalePack(SOURCE_LANGUAGE, {});
}
