import { TokenSetAppearance } from "@brainstorm/sdk-types";
import { ThemeName, defaultDark, defaultLight, themes } from "@brainstorm/tokens";
import { describe, expect, it } from "vitest";
import {
	appearanceOfTheme,
	baseVarsForTheme,
	builtinThemes,
	defaultThemeForScheme,
	detectThemeByBackground,
} from "./base-theme";

describe("builtinThemes", () => {
	it("lists every catalog theme with its appearance", () => {
		const list = builtinThemes();
		expect(list.length).toBe(Object.keys(themes).length);
		expect(list.find((o) => o.name === ThemeName.DefaultDark)?.appearance).toBe(
			TokenSetAppearance.Dark,
		);
		expect(list.find((o) => o.name === ThemeName.Sepia)?.appearance).toBe(TokenSetAppearance.Light);
	});
});

describe("appearanceOfTheme", () => {
	it("maps tokens appearance to the TokenSet vocabulary", () => {
		expect(appearanceOfTheme(ThemeName.DefaultDark)).toBe(TokenSetAppearance.Dark);
		expect(appearanceOfTheme(ThemeName.DefaultLight)).toBe(TokenSetAppearance.Light);
		expect(appearanceOfTheme(ThemeName.Midnight)).toBe(TokenSetAppearance.Dark);
	});
});

describe("baseVarsForTheme", () => {
	it("returns the flattened tokens for a built-in theme", () => {
		expect(baseVarsForTheme(ThemeName.DefaultDark)["--color-background-primary"]).toBe(
			defaultDark.color.background.primary,
		);
	});
});

describe("detectThemeByBackground", () => {
	it("matches a theme by its background colour (case/space tolerant)", () => {
		expect(detectThemeByBackground(defaultDark.color.background.primary)).toBe(ThemeName.DefaultDark);
		expect(
			detectThemeByBackground(`  ${defaultLight.color.background.primary.toUpperCase()}  `),
		).toBe(ThemeName.DefaultLight);
	});

	it("returns null for an unknown background", () => {
		expect(detectThemeByBackground("#123456")).toBeNull();
		expect(detectThemeByBackground("")).toBeNull();
	});
});

describe("defaultThemeForScheme", () => {
	it("picks the default theme per scheme", () => {
		expect(defaultThemeForScheme(true)).toBe(ThemeName.DefaultDark);
		expect(defaultThemeForScheme(false)).toBe(ThemeName.DefaultLight);
	});
});
