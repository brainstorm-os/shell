/**
 * Bridge between the editor and the built-in themes shipped in
 * `@brainstorm-os/tokens`. The editor edits a theme by **forking a base** —
 * one of the six built-ins (Default Dark/Light, Midnight, Sepia, High
 * Contrast, Solar) — and layering token overrides on top; the base
 * supplies the grid's reference column and the in-editor preview's
 * foundation. The default base is the shell's *current* theme so the
 * editor opens looking like the running app (not a forced light palette).
 */

import { TokenSetAppearance } from "@brainstorm-os/sdk-types";
import {
	DEFAULT_THEME_BY_APPEARANCE,
	ThemeAppearance,
	type ThemeName,
	flattenTokens,
	themeAppearance,
	themeCatalog,
	themes,
} from "@brainstorm-os/tokens";

export type BuiltinThemeOption = { name: ThemeName; appearance: TokenSetAppearance };

function toTokenSetAppearance(a: ThemeAppearance): TokenSetAppearance {
	return a === ThemeAppearance.Dark ? TokenSetAppearance.Dark : TokenSetAppearance.Light;
}

/** The built-in themes, in catalog order, as fork bases. */
export function builtinThemes(): BuiltinThemeOption[] {
	return themeCatalog.map((entry) => ({
		name: entry.id,
		appearance: toTokenSetAppearance(entry.appearance),
	}));
}

export function appearanceOfTheme(name: ThemeName): TokenSetAppearance {
	return toTokenSetAppearance(themeAppearance(name));
}

/** Flattened `--kebab` token values for a built-in theme — the grid base
 *  + the live-preview foundation. */
export function baseVarsForTheme(name: ThemeName): Record<string, string> {
	return flattenTokens(themes[name]);
}

/**
 * Identify the shell's current theme by matching the `:root`
 * `--color-background-primary` (the shell writes a built-in theme's exact
 * tokens to `:root`) against the catalog. Returns `null` when no built-in
 * matches (a custom shell theme).
 */
export function detectThemeByBackground(background: string): ThemeName | null {
	const needle = background.trim().toLowerCase();
	if (!needle) return null;
	for (const entry of themeCatalog) {
		if (themes[entry.id].color.background.primary.trim().toLowerCase() === needle) return entry.id;
	}
	return null;
}

/** Fallback base when the current theme can't be matched — the default
 *  theme for the detected scheme. */
export function defaultThemeForScheme(isDark: boolean): ThemeName {
	return isDark
		? DEFAULT_THEME_BY_APPEARANCE[ThemeAppearance.Dark]
		: DEFAULT_THEME_BY_APPEARANCE[ThemeAppearance.Light];
}
