// @vitest-environment jsdom
/**
 * `applyThemeVars` — an unknown theme name must fall back to DEFAULT_THEME,
 * never throw (F-480). The name comes from persisted vault state, so a build
 * older than the vault's theme (newer install wrote the slot; dev renderer
 * pre-bundled tokens before a theme merged) hits this on every repaint —
 * a throw here left the dashboard stuck and the light/dark toggle dead
 * while app windows (whose surfaces already resolve-or-fallback) kept
 * theming fine.
 */

import { AUTO_HIDE_SIDEBARS_ATTRIBUTE } from "@brainstorm-os/sdk/panel-toggle";
import {
	DEFAULT_THEME,
	DisplayAttribute,
	DisplayAttributeValue,
	ThemeName,
	flattenTokens,
	higherContrastOverrides,
	themes,
} from "@brainstorm-os/tokens";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyThemePreviewVars, applyThemeVars } from "./theme-provider";

afterEach(() => {
	document.documentElement.removeAttribute("style");
	delete document.documentElement.dataset.theme;
	vi.restoreAllMocks();
});

describe("applyThemeVars", () => {
	it("applies a known theme and stamps dataset.theme", () => {
		applyThemeVars(ThemeName.Midnight);
		expect(document.documentElement.dataset.theme).toBe(ThemeName.Midnight);
	});

	it("falls back to DEFAULT_THEME on a theme this build does not ship", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(() => applyThemeVars("theme-from-a-newer-build")).not.toThrow();
		expect(document.documentElement.dataset.theme).toBe(DEFAULT_THEME);
		expect(warn).toHaveBeenCalledOnce();
	});

	it("recovers: a later known theme paints over the fallback", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		applyThemeVars("theme-from-a-newer-build");
		applyThemeVars(ThemeName.Nord);
		expect(document.documentElement.dataset.theme).toBe(ThemeName.Nord);
	});
});

describe("applyThemeVars — visibility preferences (12.18)", () => {
	it("the SDK auto-hide hook reads the same root attribute the shell stamps (7.15)", () => {
		expect(AUTO_HIDE_SIDEBARS_ATTRIBUTE).toBe(DisplayAttribute.AutoHideSidebars);
	});

	const ALL_ON = {
		higherContrast: true,
		emphasizeTextCursor: true,
		alwaysShowScrollbars: true,
		autoHideSidebars: true,
	};

	it("layers the higher-contrast overrides and stamps every root attribute", () => {
		applyThemeVars(ThemeName.DefaultLight, ALL_ON);
		const root = document.documentElement;
		expect(root.getAttribute(DisplayAttribute.Contrast)).toBe(DisplayAttributeValue.More);
		expect(root.getAttribute(DisplayAttribute.TextEmphasis)).toBe(DisplayAttributeValue.On);
		expect(root.getAttribute(DisplayAttribute.Scrollbars)).toBe(DisplayAttributeValue.Always);
		expect(root.getAttribute(DisplayAttribute.AutoHideSidebars)).toBe(DisplayAttributeValue.On);
		expect(root.style.getPropertyValue("--color-border-default")).toBe(
			themes[ThemeName.DefaultLight].color.border.strong,
		);
	});

	it("turning the preferences off reverts the tokens and removes the attributes", () => {
		applyThemeVars(ThemeName.DefaultLight, ALL_ON);
		applyThemeVars(ThemeName.DefaultLight);
		const root = document.documentElement;
		for (const name of Object.values(DisplayAttribute)) expect(root.hasAttribute(name)).toBe(false);
		expect(root.style.getPropertyValue("--color-border-default")).toBe(
			themes[ThemeName.DefaultLight].color.border.default,
		);
	});
});

describe("applyThemePreviewVars (9.9.6)", () => {
	const ALL_ON = {
		higherContrast: true,
		emphasizeTextCursor: true,
		alwaysShowScrollbars: true,
		autoHideSidebars: true,
	};

	it("keeps the display prefs layered over a preview, computed from the previewed tokens", () => {
		applyThemeVars(ThemeName.DefaultLight, ALL_ON);
		const preview = flattenTokens(themes[ThemeName.Midnight]);
		applyThemePreviewVars(preview, ThemeName.DefaultLight, ALL_ON);
		const root = document.documentElement;
		const expected = higherContrastOverrides(themes[ThemeName.Midnight]);
		for (const [name, value] of Object.entries(expected)) {
			expect(root.style.getPropertyValue(name)).toBe(value);
		}
		expect(root.getAttribute(DisplayAttribute.Contrast)).toBe(DisplayAttributeValue.More);
	});

	it("paints the preview as-is when no display pref is on", () => {
		const preview = flattenTokens(themes[ThemeName.Midnight]);
		applyThemePreviewVars(preview, ThemeName.DefaultLight);
		expect(document.documentElement.style.getPropertyValue("--color-border-default")).toBe(
			themes[ThemeName.Midnight].color.border.default,
		);
	});
});
