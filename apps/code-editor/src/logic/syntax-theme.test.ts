import { HighlightTheme } from "@brainstorm-os/sdk/code-highlight";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_SYNTAX_THEME_PREFERENCE,
	SYNTAX_THEME_OPTIONS,
	SyntaxThemePreference,
	parseSyntaxThemePreference,
	resolveSyntaxTheme,
} from "./syntax-theme";

describe("SYNTAX_THEME_OPTIONS", () => {
	it("offers Auto, Light, Dark in menu order with label keys", () => {
		expect(SYNTAX_THEME_OPTIONS.map((o) => o.id)).toEqual([
			SyntaxThemePreference.Auto,
			SyntaxThemePreference.Light,
			SyntaxThemePreference.Dark,
		]);
		for (const option of SYNTAX_THEME_OPTIONS) {
			expect(option.labelKey).toMatch(/^syntaxTheme\./);
		}
	});

	it("defaults to Auto (follow appearance — unchanged behaviour)", () => {
		expect(DEFAULT_SYNTAX_THEME_PREFERENCE).toBe(SyntaxThemePreference.Auto);
	});
});

describe("parseSyntaxThemePreference", () => {
	it("round-trips each known wire value", () => {
		expect(parseSyntaxThemePreference("auto")).toBe(SyntaxThemePreference.Auto);
		expect(parseSyntaxThemePreference("light")).toBe(SyntaxThemePreference.Light);
		expect(parseSyntaxThemePreference("dark")).toBe(SyntaxThemePreference.Dark);
	});

	it("falls back to the default for unknown / null / empty", () => {
		expect(parseSyntaxThemePreference(null)).toBe(DEFAULT_SYNTAX_THEME_PREFERENCE);
		expect(parseSyntaxThemePreference(undefined)).toBe(DEFAULT_SYNTAX_THEME_PREFERENCE);
		expect(parseSyntaxThemePreference("")).toBe(DEFAULT_SYNTAX_THEME_PREFERENCE);
		expect(parseSyntaxThemePreference("solarized")).toBe(DEFAULT_SYNTAX_THEME_PREFERENCE);
		expect(parseSyntaxThemePreference("AUTO")).toBe(DEFAULT_SYNTAX_THEME_PREFERENCE);
	});
});

describe("resolveSyntaxTheme", () => {
	it("Auto follows the resolved appearance", () => {
		expect(resolveSyntaxTheme(SyntaxThemePreference.Auto, false)).toBe(HighlightTheme.Light);
		expect(resolveSyntaxTheme(SyntaxThemePreference.Auto, true)).toBe(HighlightTheme.Dark);
	});

	it("Light pins github-light regardless of appearance", () => {
		expect(resolveSyntaxTheme(SyntaxThemePreference.Light, false)).toBe(HighlightTheme.Light);
		expect(resolveSyntaxTheme(SyntaxThemePreference.Light, true)).toBe(HighlightTheme.Light);
	});

	it("Dark pins github-dark regardless of appearance", () => {
		expect(resolveSyntaxTheme(SyntaxThemePreference.Dark, false)).toBe(HighlightTheme.Dark);
		expect(resolveSyntaxTheme(SyntaxThemePreference.Dark, true)).toBe(HighlightTheme.Dark);
	});
});
