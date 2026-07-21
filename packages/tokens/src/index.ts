/**
 * @brainstorm-os/tokens — semantic design tokens.
 *
 * Per §Themes and :
 * apps reference tokens by semantic name, never raw values. Token sets define
 * concrete values per theme. v0 ships the default-dark / default-light pair
 * plus a small set of opinionated built-in themes (Midnight, Sepia, High
 * Contrast). Third-party theme packs install through the theme store once
 * 40-theme-store.md lands.
 */

export type { Tokens } from "./tokens";
export { flattenTokens } from "./tokens";
export type { ThemeCatalogEntry } from "./themes";
export {
	DEFAULT_THEME,
	DEFAULT_THEME_BY_APPEARANCE,
	ThemeAppearance,
	ThemeName,
	defaultDark,
	defaultLight,
	highContrast,
	isThemeName,
	midnight,
	sepia,
	themeAppearance,
	themeCatalog,
	themes,
} from "./themes";
