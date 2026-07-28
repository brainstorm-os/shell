/**
 * 12.15 slice 15d end-to-end: the SHIPPED overlay packs (`src/i18n/<tag>.json`)
 * actually load through the app's real `LOCALE_PACK_IMPORTERS` and overlay the
 * English catalog — the runtime proof that switching the shell language flips
 * this app's chrome (the non-React `i18n-boot` seam re-renders on the swap).
 */
import { createT, resolveLocalePack } from "@brainstorm-os/sdk/i18n";
import { describe, expect, it } from "vitest";
import { DATABASE_I18N, LOCALE_PACK_IMPORTERS } from "./i18n";

const OVERLAY_LOCALES = ["es", "de", "fr", "it", "pt"] as const;

/** A key whose translation genuinely differs from English (skips proper nouns
 *  and format names that stay identical across locales). */
function firstDivergentKey(pack: Record<string, string>): string | undefined {
	return Object.keys(pack).find(
		(k) => k in DATABASE_I18N && pack[k] !== (DATABASE_I18N as Record<string, string>)[k],
	);
}

describe("database real overlay packs (12.15 15d)", () => {
	for (const locale of OVERLAY_LOCALES) {
		it(`loads and overlays the ${locale} pack`, async () => {
			const pack = await resolveLocalePack(locale, LOCALE_PACK_IMPORTERS);
			expect(pack).not.toBeNull();
			const packRec = (pack ?? {}) as Record<string, string>;
			// Full-parity packs: every English key is present.
			expect(Object.keys(packRec).length).toBe(Object.keys(DATABASE_I18N).length);

			const key = firstDivergentKey(packRec);
			expect(key).toBeDefined();
			const k = key as string;

			const translate = createT(DATABASE_I18N, pack ?? {});
			expect(translate(k as keyof typeof DATABASE_I18N)).toBe(packRec[k]);
			expect(translate(k as keyof typeof DATABASE_I18N)).not.toBe(
				(DATABASE_I18N as Record<string, string>)[k],
			);
		});
	}
});
