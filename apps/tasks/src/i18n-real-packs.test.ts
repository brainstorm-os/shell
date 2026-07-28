/**
 * 12.15 end-to-end: the SHIPPED overlay packs (`src/i18n/<tag>.json`) actually
 * load through the app's real `LOCALE_PACK_IMPORTERS` and overlay the English
 * manifest — the runtime proof that switching the shell language flips this
 * app's chrome (the hooks/provider/seam wiring is unit-tested elsewhere; this
 * pins that the real es/de/fr/it/pt content is reachable and non-empty).
 */
import { createT, resolveLocalePack } from "@brainstorm-os/sdk/i18n";
import { describe, expect, it } from "vitest";
import { LOCALE_PACK_IMPORTERS, TASKS_I18N } from "./i18n/t";

const OVERLAY_LOCALES = ["es", "de", "fr", "it", "pt"] as const;

/** A key whose translation genuinely differs from English (skips proper nouns
 *  like the app title that stay identical across locales). */
function firstDivergentKey(pack: Record<string, string>): string | undefined {
	return Object.keys(pack).find(
		(k) => k in TASKS_I18N && pack[k] !== (TASKS_I18N as Record<string, string>)[k],
	);
}

describe("tasks real overlay packs (12.15)", () => {
	for (const locale of OVERLAY_LOCALES) {
		it(`loads and overlays the ${locale} pack`, async () => {
			const pack = await resolveLocalePack(locale, LOCALE_PACK_IMPORTERS);
			expect(pack).not.toBeNull();
			const packRec = (pack ?? {}) as Record<string, string>;
			expect(Object.keys(packRec).length).toBeGreaterThan(0);

			const key = firstDivergentKey(packRec);
			expect(key).toBeDefined();
			const k = key as string;

			const translate = createT(TASKS_I18N, pack ?? {});
			expect(translate(k as keyof typeof TASKS_I18N)).toBe(packRec[k]);
			expect(translate(k as keyof typeof TASKS_I18N)).not.toBe(
				(TASKS_I18N as Record<string, string>)[k],
			);
		});
	}
});
