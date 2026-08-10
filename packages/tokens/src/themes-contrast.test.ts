import {
	CONTRAST_PAIRS,
	SURFACE_PAIRS,
	lintSurfaceSeparation,
	lintTokenContrast,
} from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { ThemeName, themes } from "./themes";
import { flattenTokens } from "./tokens";

/**
 * WCAG AA contrast ratchet over EVERY built-in theme.
 *
 * The prior a11y sweep bumped muted text to AA but left accent-coloured TEXT
 * deferred as a "brand decision" (several light themes rendered accent text at
 * ~3.3–3.9:1, under the 4.5:1 bar). 11.x resolves that with a dedicated
 * `accent.onSurface` token (accent tuned for text, distinct from the brand fill
 * `accent.default`) and this test turns the decision into an enforced
 * invariant: every `CONTRAST_PAIRS` entry — primary/secondary/tertiary text,
 * link, accent-on-surface, accent-text-on-accent, inverse, chrome — must meet
 * its required ratio in every built-in theme. A regression (a new theme, or a token
 * tweak that darkens a background) fails here, not in the field.
 *
 * POLISH-DSN-13 extends it to the three FACES the 329 fleet audit found broken,
 * because every one of them was pure token arithmetic that no test looked at:
 *
 *   • the accent BUTTON face (`gloss.label` on `gloss.top`/`gloss.bottom`) —
 *     Default Dark shipped a near-black label on the same indigo Default Light
 *     labels in white, and eight of the fourteen themes were under 4.5:1;
 *   • the DISABLED filled face (`text.tertiary` on `surface.raised`) — the
 *     state Chat's send glyph dissolved into at ~1.3:1;
 *   • the floating TOOLTIP chip, which must be contrast-DISTINCT from the page
 *     it floats over — on the dark themes it resolved to the page background
 *     itself, so the chip had no fill, no border and no shadow.
 */
describe("built-in theme contrast — WCAG AA ratchet", () => {
	for (const name of Object.values(ThemeName)) {
		it(`${name}: every text/accent pair meets its AA bar`, () => {
			const flat = flattenTokens(themes[name]);
			const issues = lintTokenContrast((token) => flat[token]);
			// Surface the offending pairs + ratios in the failure message. Zero
			// deferrals — 12.16 fixed accent-as-text (`accent.onSurface`) and 12.17
			// fixed white-text-on-accent-fill (`accent.onFill`); every pair now
			// clears its bar in every built-in theme.
			const detail = issues
				.map((issue) => `${issue.pairId} ${issue.ratio.toFixed(2)}:1 < ${issue.required}:1`)
				.join(", ");
			expect(issues, `${name} fails: ${detail}`).toEqual([]);
		});
	}

	for (const name of Object.values(ThemeName)) {
		it(`${name}: every floating surface separates from the page`, () => {
			const flat = flattenTokens(themes[name]);
			const issues = lintSurfaceSeparation((token) => flat[token]);
			const detail = issues
				.map((issue) => `${issue.pairId} ${issue.ratio.toFixed(2)}:1 < ${issue.required}:1`)
				.join(", ");
			expect(issues, `${name} fails: ${detail}`).toEqual([]);
		});
	}

	it("every asserted foreground/background resolves in every theme", () => {
		// Guards the ratchet itself: a pair naming a token that no theme defines
		// would be silently skipped by the lints, hiding a real gap.
		for (const name of Object.values(ThemeName)) {
			const flat = flattenTokens(themes[name]);
			for (const pair of CONTRAST_PAIRS) {
				expect(flat[pair.foreground], `${name} missing ${pair.foreground}`).toBeDefined();
				expect(flat[pair.background], `${name} missing ${pair.background}`).toBeDefined();
			}
			for (const pair of SURFACE_PAIRS) {
				expect(flat[pair.surface], `${name} missing ${pair.surface}`).toBeDefined();
				expect(flat[pair.against], `${name} missing ${pair.against}`).toBeDefined();
			}
		}
	});
});
