import { CONTRAST_PAIRS, lintTokenContrast } from "@brainstorm/sdk-types";
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
/**
 * Known-deferred contrast failures, tracked so the ratchet still enforces every
 * OTHER pair + catches regressions. The ONLY entry is `accent-text-on-accent`:
 * white `accent.text` on the LIGHT accent FILL (`accent.default`) measures
 * ~3.6–3.9:1 in three light themes. This is the INVERSE of the accent-as-text
 * tail fixed here (text sits ON an accent fill, not accent used AS text) and the
 * report scoped it separately: it needs its own per-theme `accent.onFill` token
 * + a brand review of the ~12 accent-fill-with-text sites (membership badges,
 * etc.). A global `accent.default → strong` swap can't fix it — that clears the
 * light themes but breaks nord/aurora (their dark `accent.text` on the darker
 * strong fill). Remove a theme's entry when that follow-up lands; the
 * "still-deferred" assertion below fails on an accidental fix so the list can't
 * silently rot.
 */
const KNOWN_DEFERRED: Partial<Record<ThemeName, readonly string[]>> = {
	[ThemeName.DefaultLight]: ["accent-text-on-accent"],
	[ThemeName.Solar]: ["accent-text-on-accent"],
	[ThemeName.Mint]: ["accent-text-on-accent"],
};

describe("built-in theme contrast — WCAG AA ratchet", () => {
	for (const name of Object.values(ThemeName)) {
		it(`${name}: every non-deferred text/accent pair meets its AA bar`, () => {
			const flat = flattenTokens(themes[name]);
			const issues = lintTokenContrast((token) => flat[token]);
			const deferred = new Set(KNOWN_DEFERRED[name] ?? []);

			// No failure outside the documented deferred set (catches regressions).
			const unexpected = issues.filter((issue) => !deferred.has(issue.pairId));
			const detail = unexpected
				.map((issue) => `${issue.pairId} ${issue.ratio.toFixed(2)}:1 < ${issue.required}:1`)
				.join(", ");
			expect(unexpected, `${name} has un-deferred failures: ${detail}`).toEqual([]);

			// Every deferred pair must STILL be failing — an accidental fix trips
			// this so the KNOWN_DEFERRED entry gets removed rather than rot.
			const failingIds = new Set(issues.map((issue) => issue.pairId));
			for (const pairId of deferred) {
				expect(
					failingIds.has(pairId),
					`${name}: ${pairId} no longer fails — drop it from KNOWN_DEFERRED`,
				).toBe(true);
			}
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
