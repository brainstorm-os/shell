/**
 * 12.15 slice 15d end-to-end: the SHIPPED overlay packs (`src/i18n/<tag>.json`)
 * actually load through the app's real `LOCALE_PACK_IMPORTERS` and overlay the
 * English manifest — the runtime proof that switching the shell language flips
 * this app's chrome.
 */
import { createT, resolveLocalePack } from "@brainstorm-os/sdk/i18n";
import { describe, expect, it } from "vitest";
import { LOCALE_PACK_IMPORTERS, WHITEBOARD_MANIFEST } from "./i18n/t";

const OVERLAY_LOCALES = ["es", "de", "fr", "it", "pt"] as const;

/** A key whose translation genuinely differs from English (skips proper nouns
 *  like the app title that stay identical across locales). */
function firstDivergentKey(pack: Record<string, string>): string | undefined {
	return Object.keys(pack).find(
		(k) => k in WHITEBOARD_MANIFEST && pack[k] !== (WHITEBOARD_MANIFEST as Record<string, string>)[k],
	);
}

describe("whiteboard real overlay packs (12.15 15d)", () => {
	for (const locale of OVERLAY_LOCALES) {
		it(`loads and overlays the ${locale} pack`, async () => {
			const pack = await resolveLocalePack(locale, LOCALE_PACK_IMPORTERS);
			expect(pack).not.toBeNull();
			const packRec = (pack ?? {}) as Record<string, string>;
			// Full-parity packs: every English key is present.
			expect(Object.keys(packRec).length).toBe(Object.keys(WHITEBOARD_MANIFEST).length);

			const key = firstDivergentKey(packRec);
			expect(key).toBeDefined();
			const k = key as string;

			const translate = createT(WHITEBOARD_MANIFEST, pack ?? {});
			expect(translate(k as keyof typeof WHITEBOARD_MANIFEST)).toBe(packRec[k]);
			expect(translate(k as keyof typeof WHITEBOARD_MANIFEST)).not.toBe(
				(WHITEBOARD_MANIFEST as Record<string, string>)[k],
			);
		});
	}
});
