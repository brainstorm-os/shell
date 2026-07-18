import { describe, expect, it } from "vitest";
import {
	DEFAULT_THEME,
	DEFAULT_THEME_BY_APPEARANCE,
	ThemeAppearance,
	ThemeName,
	aurora,
	defaultDark,
	defaultLight,
	forest,
	highContrast,
	isThemeName,
	midnight,
	mint,
	nord,
	rose,
	sepia,
	slate,
	solar,
	themeAppearance,
	themeCatalog,
	themes,
} from "./themes";
import { flattenTokens } from "./tokens";

describe("themes catalog", () => {
	it("registers every ThemeName enum member in the themes record", () => {
		const ids = Object.values(ThemeName);
		for (const id of ids) {
			expect(themes[id]).toBeDefined();
		}
	});

	it("DEFAULT_THEME points at a real theme", () => {
		expect(themes[DEFAULT_THEME]).toBeDefined();
	});

	it("isThemeName narrows valid ids and rejects unknown strings", () => {
		for (const id of Object.values(ThemeName)) {
			expect(isThemeName(id)).toBe(true);
		}
		expect(isThemeName("not-a-theme")).toBe(false);
		expect(isThemeName(undefined)).toBe(false);
		expect(isThemeName(42)).toBe(false);
	});

	it("themeCatalog covers every theme and uses the actual token palette as preview", () => {
		const catalogIds = themeCatalog.map((entry) => entry.id);
		for (const id of Object.values(ThemeName)) {
			expect(catalogIds).toContain(id);
		}
		for (const entry of themeCatalog) {
			const tokens = themes[entry.id];
			expect(entry.preview.background).toBe(tokens.color.background.primary);
			expect(entry.preview.surface).toBe(tokens.color.background.elevated);
			expect(entry.preview.accent).toBe(tokens.color.accent.default);
			expect(entry.preview.text).toBe(tokens.color.text.primary);
		}
	});

	it("every theme flattens to the same set of CSS custom properties", () => {
		const baseKeys = Object.keys(flattenTokens(defaultDark)).sort();
		for (const tokens of [
			defaultLight,
			midnight,
			sepia,
			highContrast,
			solar,
			forest,
			nord,
			aurora,
			mint,
			rose,
			slate,
		]) {
			const keys = Object.keys(flattenTokens(tokens)).sort();
			expect(keys).toEqual(baseKeys);
		}
	});

	it("every catalog entry declares a ThemeAppearance and themeAppearance() reads it back", () => {
		const schemes = new Set<ThemeAppearance>([ThemeAppearance.Light, ThemeAppearance.Dark]);
		for (const entry of themeCatalog) {
			expect(schemes.has(entry.appearance)).toBe(true);
			expect(themeAppearance(entry.id)).toBe(entry.appearance);
		}
	});

	it("DEFAULT_THEME_BY_APPEARANCE picks a built-in default per scheme", () => {
		expect(DEFAULT_THEME_BY_APPEARANCE[ThemeAppearance.Light]).toBe(ThemeName.DefaultLight);
		expect(DEFAULT_THEME_BY_APPEARANCE[ThemeAppearance.Dark]).toBe(ThemeName.DefaultDark);
		// And both are real themes.
		for (const id of Object.values(DEFAULT_THEME_BY_APPEARANCE)) {
			expect(themes[id]).toBeDefined();
		}
	});
});
