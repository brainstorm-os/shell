import { ThemeName } from "@brainstorm-os/tokens";
import { describe, expect, it } from "vitest";
import {
	AppearanceMode,
	AppearanceSlot,
	type AppearanceState,
	effectiveSlotFor,
	isAppearanceMode,
	isAppearanceSlot,
	nextModeForToggle,
	resolveEffectiveAppearance,
	slotForTheme,
} from "./appearance";

const SAMPLE_STATE: AppearanceState = {
	mode: AppearanceMode.Auto,
	light: {
		theme: ThemeName.DefaultLight,
		wallpaper: { kind: "solid", value: "#f5f3ef" },
	},
	dark: {
		theme: ThemeName.DefaultDark,
		wallpaper: { kind: "solid", value: "#14161b" },
	},
};

describe("effectiveSlotFor", () => {
	it("returns the explicit slot for explicit modes", () => {
		expect(effectiveSlotFor(AppearanceMode.Light, true)).toBe(AppearanceSlot.Light);
		expect(effectiveSlotFor(AppearanceMode.Light, false)).toBe(AppearanceSlot.Light);
		expect(effectiveSlotFor(AppearanceMode.Dark, true)).toBe(AppearanceSlot.Dark);
		expect(effectiveSlotFor(AppearanceMode.Dark, false)).toBe(AppearanceSlot.Dark);
	});

	it("follows the OS preference under Auto", () => {
		expect(effectiveSlotFor(AppearanceMode.Auto, true)).toBe(AppearanceSlot.Dark);
		expect(effectiveSlotFor(AppearanceMode.Auto, false)).toBe(AppearanceSlot.Light);
	});
});

describe("resolveEffectiveAppearance", () => {
	it("picks the dark pair when the effective slot is Dark", () => {
		const resolved = resolveEffectiveAppearance({
			state: { ...SAMPLE_STATE, mode: AppearanceMode.Dark },
			systemPrefersDark: false,
		});
		expect(resolved.effectiveMode).toBe(AppearanceSlot.Dark);
		expect(resolved.theme).toBe(ThemeName.DefaultDark);
		expect(resolved.wallpaper.value).toBe("#14161b");
	});

	it("picks the light pair when the effective slot is Light", () => {
		const resolved = resolveEffectiveAppearance({
			state: { ...SAMPLE_STATE, mode: AppearanceMode.Light },
			systemPrefersDark: true,
		});
		expect(resolved.effectiveMode).toBe(AppearanceSlot.Light);
		expect(resolved.theme).toBe(ThemeName.DefaultLight);
		expect(resolved.wallpaper.value).toBe("#f5f3ef");
	});

	it("honours the OS preference under Auto", () => {
		const auto = (systemPrefersDark: boolean) =>
			resolveEffectiveAppearance({ state: SAMPLE_STATE, systemPrefersDark });
		expect(auto(true).effectiveMode).toBe(AppearanceSlot.Dark);
		expect(auto(false).effectiveMode).toBe(AppearanceSlot.Light);
	});
});

describe("slotForTheme", () => {
	it("maps every built-in theme onto a slot", () => {
		expect(slotForTheme(ThemeName.DefaultLight)).toBe(AppearanceSlot.Light);
		expect(slotForTheme(ThemeName.Sepia)).toBe(AppearanceSlot.Light);
		expect(slotForTheme(ThemeName.DefaultDark)).toBe(AppearanceSlot.Dark);
		expect(slotForTheme(ThemeName.Midnight)).toBe(AppearanceSlot.Dark);
		expect(slotForTheme(ThemeName.HighContrast)).toBe(AppearanceSlot.Dark);
	});
});

describe("nextModeForToggle", () => {
	it("flips between explicit modes", () => {
		expect(nextModeForToggle(AppearanceMode.Light, false)).toBe(AppearanceMode.Dark);
		expect(nextModeForToggle(AppearanceMode.Dark, false)).toBe(AppearanceMode.Light);
	});

	it("pins the explicit opposite of the OS preference when coming from Auto", () => {
		expect(nextModeForToggle(AppearanceMode.Auto, true)).toBe(AppearanceMode.Light);
		expect(nextModeForToggle(AppearanceMode.Auto, false)).toBe(AppearanceMode.Dark);
	});

	it("never returns Auto — re-entering Auto is a Settings-only path", () => {
		const cases: ReadonlyArray<[AppearanceMode, boolean]> = [
			[AppearanceMode.Light, true],
			[AppearanceMode.Light, false],
			[AppearanceMode.Dark, true],
			[AppearanceMode.Dark, false],
			[AppearanceMode.Auto, true],
			[AppearanceMode.Auto, false],
		];
		for (const [mode, prefersDark] of cases) {
			expect(nextModeForToggle(mode, prefersDark)).not.toBe(AppearanceMode.Auto);
		}
	});
});

describe("guards", () => {
	it("isAppearanceMode rejects unknown values", () => {
		for (const value of Object.values(AppearanceMode)) {
			expect(isAppearanceMode(value)).toBe(true);
		}
		expect(isAppearanceMode("system")).toBe(false);
		expect(isAppearanceMode(null)).toBe(false);
		expect(isAppearanceMode(0)).toBe(false);
	});

	it("isAppearanceSlot accepts only Light/Dark", () => {
		expect(isAppearanceSlot(AppearanceSlot.Light)).toBe(true);
		expect(isAppearanceSlot(AppearanceSlot.Dark)).toBe(true);
		expect(isAppearanceSlot("auto")).toBe(false);
		expect(isAppearanceSlot(undefined)).toBe(false);
	});
});
