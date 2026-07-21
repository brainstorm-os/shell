import { CONTRAST_PAIRS, lintTokenContrast } from "@brainstorm-os/sdk-types";
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
 * its required ratio in all 12 themes. A regression (a new theme, or a token
 * tweak that darkens a background) fails here, not in the field.
 */
describe("built-in theme contrast — WCAG AA ratchet", () => {
	for (const name of Object.values(ThemeName)) {
		it(`${name}: every text/accent pair meets its AA bar`, () => {
			const flat = flattenTokens(themes[name]);
			const issues = lintTokenContrast((token) => flat[token]);
			// Surface the offending pairs + ratios in the failure message. Zero
			// deferrals — 12.16 fixed accent-as-text (`accent.onSurface`) and 12.17
			// fixed white-text-on-accent-fill (`accent.onFill`); every pair now
			// clears its bar in all 12 themes.
			const detail = issues
				.map((issue) => `${issue.pairId} ${issue.ratio.toFixed(2)}:1 < ${issue.required}:1`)
				.join(", ");
			expect(issues, `${name} fails: ${detail}`).toEqual([]);
		});
	}

	it("every CONTRAST_PAIRS foreground/background resolves in every theme", () => {
		// Guards the ratchet itself: a pair naming a token that no theme defines
		// would be silently skipped by `lintTokenContrast`, hiding a real gap.
		for (const name of Object.values(ThemeName)) {
			const flat = flattenTokens(themes[name]);
			for (const pair of CONTRAST_PAIRS) {
				expect(flat[pair.foreground], `${name} missing ${pair.foreground}`).toBeDefined();
				expect(flat[pair.background], `${name} missing ${pair.background}`).toBeDefined();
			}
		}
	});
});
