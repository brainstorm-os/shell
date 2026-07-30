/**
 * Syntax-theme preference for the code-editor's Shiki highlight (9.7.9).
 *
 * The shared tokenizer (`@brainstorm-os/sdk/code-highlight`) bundles exactly two
 * Shiki themes — GitHub Light + GitHub Dark — loaded once at startup. This
 * module is the pure decision layer on top: the user picks a *preference*
 * (Auto / Light / Dark), the editor persists the string, and
 * {@link resolveSyntaxTheme} maps that preference + the current colour scheme
 * to one of the two concrete {@link HighlightTheme} values the SDK can paint.
 *
 * `Auto` (the default) follows the shell's `prefers-color-scheme`, so the
 * out-of-the-box behaviour is unchanged from before the selector existed; an
 * explicit Light/Dark pins the highlight regardless of appearance.
 *
 * Kept free of DOM + the SDK runtime so it unit-tests in isolation: the
 * available preferences, the appearance-driven default, the pinned overrides,
 * and the unknown-value fallback.
 */

import { HighlightTheme } from "@brainstorm-os/sdk/code-highlight";

/** A persisted syntax-theme choice. `Auto` tracks the shell appearance; the
 *  others pin one of the two bundled Shiki themes. Wire format is the string
 *  value — centralised here so a typo can't compile (no raw discriminators). */
export enum SyntaxThemePreference {
	Auto = "auto",
	Light = "light",
	Dark = "dark",
}

/** The selectable preferences in menu order. Auto first (the default), then
 *  the explicit pins. The label is a manifest key the app resolves through
 *  `t()` — this module stays free of user copy. */
export interface SyntaxThemeOption {
	readonly id: SyntaxThemePreference;
	readonly labelKey: string;
}

export const SYNTAX_THEME_OPTIONS: readonly SyntaxThemeOption[] = Object.freeze([
	{ id: SyntaxThemePreference.Auto, labelKey: "syntaxTheme.auto" },
	{ id: SyntaxThemePreference.Light, labelKey: "syntaxTheme.light" },
	{ id: SyntaxThemePreference.Dark, labelKey: "syntaxTheme.dark" },
]);

/** The default preference — follow the shell appearance, matching the
 *  pre-selector behaviour. */
export const DEFAULT_SYNTAX_THEME_PREFERENCE = SyntaxThemePreference.Auto;

/** Coerce an arbitrary persisted string (or `null`) into a known preference.
 *  Anything we don't recognise — a stale key, a corrupted store, a future id
 *  this build predates — falls back to {@link DEFAULT_SYNTAX_THEME_PREFERENCE}
 *  so the editor never renders against an undefined theme. */
export function parseSyntaxThemePreference(raw: string | null | undefined): SyntaxThemePreference {
	switch (raw) {
		case SyntaxThemePreference.Auto:
			return SyntaxThemePreference.Auto;
		case SyntaxThemePreference.Light:
			return SyntaxThemePreference.Light;
		case SyntaxThemePreference.Dark:
			return SyntaxThemePreference.Dark;
		default:
			return DEFAULT_SYNTAX_THEME_PREFERENCE;
	}
}

/** Resolve a preference to the concrete {@link HighlightTheme} the tokenizer
 *  paints. `Auto` defers to `prefersDark` (the shell's resolved appearance);
 *  Light/Dark pin regardless. */
export function resolveSyntaxTheme(
	preference: SyntaxThemePreference,
	prefersDark: boolean,
): HighlightTheme {
	switch (preference) {
		case SyntaxThemePreference.Light:
			return HighlightTheme.Light;
		case SyntaxThemePreference.Dark:
			return HighlightTheme.Dark;
		default:
			return prefersDark ? HighlightTheme.Dark : HighlightTheme.Light;
	}
}
