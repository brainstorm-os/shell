/**
 * Pure resolution of the active (theme, wallpaper) pair from the user's
 * appearance state — per §Appearance modes
 * & pair slots.
 *
 * The runtime split:
 *   - This module is pure (no electron, no DOM, no Yjs). It runs in main
 *     and renderer alike.
 *   - The dashboard renderer + IPC handlers both call into it so a slot
 *     edit and a system-preference flip resolve identically.
 *
 * Inputs:
 *   - `mode`            — user's chosen mode (`light` / `dark` / `auto`).
 *   - `light` / `dark`  — the two saved pairs.
 *   - `systemPrefersDark` — OS `prefers-color-scheme` snapshot; main reads
 *                            this via Electron's `nativeTheme`, renderer
 *                            reads it via `matchMedia`. The pure resolver
 *                            doesn't pick a side — the caller hands the
 *                            current value in.
 *
 * Output:
 *   - `effectiveMode` — `light` or `dark` (never `auto`).
 *   - `theme` / `wallpaper` — the active pair, by `effectiveMode`.
 *
 * `AppearanceMode` is a string enum so it sits next to the rest of the
 * project's enums (no raw string literals as discriminators — per the
 * CLAUDE.md guidance).
 */

import { type ThemeName, themeAppearance } from "@brainstorm-os/tokens";

export enum AppearanceMode {
	Light = "light",
	Dark = "dark",
	Auto = "auto",
}

export enum AppearanceSlot {
	Light = "light",
	Dark = "dark",
}

export type AppearanceWallpaper = {
	kind: "image" | "gradient" | "solid";
	value: string;
};

export type AppearancePair = {
	theme: ThemeName;
	wallpaper: AppearanceWallpaper;
};

export type AppearanceState = {
	mode: AppearanceMode;
	light: AppearancePair;
	dark: AppearancePair;
};

export type ResolvedAppearance = {
	/** Same as `mode` unless `mode === Auto`, in which case the OS pref decides. */
	effectiveMode: AppearanceSlot;
	theme: ThemeName;
	wallpaper: AppearanceWallpaper;
};

export type ResolveInputs = {
	state: AppearanceState;
	systemPrefersDark: boolean;
};

export function resolveEffectiveAppearance(inputs: ResolveInputs): ResolvedAppearance {
	const effectiveMode = effectiveSlotFor(inputs.state.mode, inputs.systemPrefersDark);
	const pair = effectiveMode === AppearanceSlot.Dark ? inputs.state.dark : inputs.state.light;
	return {
		effectiveMode,
		theme: pair.theme,
		wallpaper: pair.wallpaper,
	};
}

/** Which slot is live for the given mode + OS preference. Exported because
 *  the toggle-shortcut handler needs to know what "the opposite" is without
 *  going through the full pair lookup. */
export function effectiveSlotFor(mode: AppearanceMode, systemPrefersDark: boolean): AppearanceSlot {
	switch (mode) {
		case AppearanceMode.Light:
			return AppearanceSlot.Light;
		case AppearanceMode.Dark:
			return AppearanceSlot.Dark;
		case AppearanceMode.Auto:
			return systemPrefersDark ? AppearanceSlot.Dark : AppearanceSlot.Light;
	}
}

/** Map a theme's declared `ThemeAppearance` onto a slot. The mapping is
 *  trivial (same enum values stored as strings) but kept behind a helper so
 *  callers can't accidentally cast `ThemeAppearance` → `AppearanceSlot`
 *  without going through a known function. */
export function slotForTheme(theme: ThemeName): AppearanceSlot {
	return themeAppearance(theme) === "light" ? AppearanceSlot.Light : AppearanceSlot.Dark;
}

/** Mode the `appearance.toggle` shortcut should commit, given the current
 *  state and OS preference. Spec (per):
 *    - From an explicit `Light`/`Dark`, flip to the other.
 *    - From `Auto`, pin the explicit OPPOSITE of the currently-resolved
 *      slot so the user gets the immediate visual change they expected.
 *      Re-entering Auto is an explicit Settings action — the toggle never
 *      lands there.
 */
export function nextModeForToggle(
	current: AppearanceMode,
	systemPrefersDark: boolean,
): AppearanceMode {
	const effective = effectiveSlotFor(current, systemPrefersDark);
	return effective === AppearanceSlot.Light ? AppearanceMode.Dark : AppearanceMode.Light;
}

export function isAppearanceMode(value: unknown): value is AppearanceMode {
	return (
		value === AppearanceMode.Light || value === AppearanceMode.Dark || value === AppearanceMode.Auto
	);
}

export function isAppearanceSlot(value: unknown): value is AppearanceSlot {
	return value === AppearanceSlot.Light || value === AppearanceSlot.Dark;
}
