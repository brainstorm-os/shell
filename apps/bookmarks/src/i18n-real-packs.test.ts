/**
 * 12.15 end-to-end: the SHIPPED overlay packs (`src/i18n/<tag>.json`) actually
 * load through the app's real `LOCALE_PACK_IMPORTERS` and overlay the English
 * catalog — the runtime proof that switching the shell language flips this
 * app's chrome (the hooks/provider/seam wiring is unit-tested elsewhere; this
 * pins that the real es/de/fr/it/pt content is reachable and non-empty).
 */
import { createT, resolveLocalePack } from "@brainstorm-os/sdk/i18n";
import { describe, expect, it } from "vitest";
import { BOOKMARKS_MESSAGES, LOCALE_PACK_IMPORTERS } from "./i18n/manifest";

const OVERLAY_LOCALES = ["es", "de", "fr", "it", "pt"] as const;

/** A key whose translation genuinely differs from English (skips proper nouns
 *  like format names that stay identical across locales). */
function firstDivergentKey(pack: Record<string, string>): string | undefined {
	return Object.keys(pack).find(
		(k) => k in BOOKMARKS_MESSAGES && pack[k] !== (BOOKMARKS_MESSAGES as Record<string, string>)[k],
	);
}

describe("bookmarks real overlay packs (12.15)", () => {
	for (const locale of OVERLAY_LOCALES) {
		it(`loads and overlays the ${locale} pack`, async () => {
			const pack = await resolveLocalePack(locale, LOCALE_PACK_IMPORTERS);
			expect(pack).not.toBeNull();
			const packRec = (pack ?? {}) as Record<string, string>;
			expect(Object.keys(packRec).length).toBeGreaterThan(0);

			const key = firstDivergentKey(packRec);
			expect(key).toBeDefined();
			const k = key as string;

			const translate = createT(BOOKMARKS_MESSAGES, pack ?? {});
			expect(translate(k as keyof typeof BOOKMARKS_MESSAGES)).toBe(packRec[k]);
			expect(translate(k as keyof typeof BOOKMARKS_MESSAGES)).not.toBe(
				(BOOKMARKS_MESSAGES as Record<string, string>)[k],
			);
		});
	}
});
