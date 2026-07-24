/**
 * 12.15 end-to-end: the SHIPPED overlay packs (`src/i18n/<tag>.json`) actually
 * load through the app's real `LOCALE_PACK_IMPORTERS` and overlay the English
 * manifest — the runtime proof that switching the shell language flips this
 * app's chrome (the hooks/provider/seam wiring is unit-tested elsewhere; this
 * pins that the real de/fr/it/pt content is reachable and non-empty).
 */
import { createT, resolveLocalePack } from "@brainstorm-os/sdk/i18n";
import { describe, expect, it } from "vitest";
import { CHAT_I18N, LOCALE_PACK_IMPORTERS } from "./i18n";

const OVERLAY_LOCALES = ["de", "fr", "it", "pt"] as const;

/** A key whose translation genuinely differs from English (skips proper nouns
 *  like the app title that stay identical across locales). */
function firstDivergentKey(pack: Record<string, string>): string | undefined {
	return Object.keys(pack).find(
		(k) => k in CHAT_I18N && pack[k] !== (CHAT_I18N as Record<string, string>)[k],
	);
}

describe("chat real overlay packs (12.15)", () => {
	for (const locale of OVERLAY_LOCALES) {
		it(`loads and overlays the ${locale} pack`, async () => {
			const pack = await resolveLocalePack(locale, LOCALE_PACK_IMPORTERS);
			expect(pack).not.toBeNull();
			const packRec = (pack ?? {}) as Record<string, string>;
			expect(Object.keys(packRec).length).toBeGreaterThan(0);

			const key = firstDivergentKey(packRec);
			expect(key).toBeDefined();
			const k = key as string;

			const translate = createT(CHAT_I18N, pack ?? {});
			// The translated string is the pack value, not the English default.
			expect(translate(k as keyof typeof CHAT_I18N)).toBe(packRec[k]);
			expect(translate(k as keyof typeof CHAT_I18N)).not.toBe(
				(CHAT_I18N as Record<string, string>)[k],
			);
		});
	}
});
