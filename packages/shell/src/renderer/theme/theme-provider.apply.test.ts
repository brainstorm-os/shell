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

import { DEFAULT_THEME, ThemeName } from "@brainstorm-os/tokens";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyThemeVars } from "./theme-provider";

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
