/**
 * `effectiveTheme` — the welcome screen (no open vault) pins Default Light so
 * a stale palette can't clash with the green-valley splash; an open vault
 * resolves its theme from `appearance` + the live OS dark preference (the same
 * slot the app windows use), falling back to DEFAULT_THEME until a snapshot
 * arrives.
 */

import {
	AppearanceMode,
	type AppearancePair,
	type AppearanceState,
} from "@brainstorm-os/protocol/appearance";
import { DEFAULT_THEME, ThemeName } from "@brainstorm-os/tokens";
import { describe, expect, it } from "vitest";
import { effectiveTheme } from "./theme-provider";

function pair(theme: ThemeName): AppearancePair {
	return { theme, wallpaper: { kind: "solid", value: "#000" } };
}

function appearance(mode: AppearanceMode, light: ThemeName, dark: ThemeName): AppearanceState {
	return { mode, light: pair(light), dark: pair(dark) };
}

const SAMPLE = appearance(AppearanceMode.Auto, ThemeName.DefaultLight, ThemeName.Midnight);

describe("effectiveTheme", () => {
	it("pins Default Light on the welcome screen regardless of appearance", () => {
		expect(effectiveTheme(false, undefined, false)).toBe(ThemeName.DefaultLight);
		expect(effectiveTheme(false, SAMPLE, true)).toBe(ThemeName.DefaultLight);
	});

	it("falls back to DEFAULT_THEME for an open vault before its first snapshot", () => {
		expect(effectiveTheme(true, undefined, false)).toBe(DEFAULT_THEME);
	});

	it("explicit Light/Dark mode picks that slot's theme, ignoring the OS pref", () => {
		const a = appearance(AppearanceMode.Light, ThemeName.Sepia, ThemeName.Midnight);
		expect(effectiveTheme(true, a, false)).toBe(ThemeName.Sepia);
		expect(effectiveTheme(true, a, true)).toBe(ThemeName.Sepia);
		const b = appearance(AppearanceMode.Dark, ThemeName.Sepia, ThemeName.Solar);
		expect(effectiveTheme(true, b, false)).toBe(ThemeName.Solar);
	});

	it("Auto mode follows the live OS dark preference (the bug fix)", () => {
		// OS light → light slot; OS dark → dark slot. Previously the dashboard was
		// pinned to the dark slot in Auto regardless of the real OS pref.
		expect(effectiveTheme(true, SAMPLE, false)).toBe(ThemeName.DefaultLight);
		expect(effectiveTheme(true, SAMPLE, true)).toBe(ThemeName.Midnight);
	});
});
