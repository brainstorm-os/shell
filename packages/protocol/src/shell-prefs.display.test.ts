import { DisplayAttribute, DisplayAttributeValue, ThemeName, themes } from "@brainstorm-os/tokens";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_DISPLAY_PREFS,
	DISPLAY_PREF_KEYS,
	decodeDisplayPrefs,
	encodeDisplayPrefs,
	resolveDisplayPaint,
	toDisplayPrefs,
} from "./shell-prefs";

describe("display prefs (12.18)", () => {
	it("defaults to everything off", () => {
		for (const key of DISPLAY_PREF_KEYS) expect(DEFAULT_DISPLAY_PREFS[key]).toBe(false);
	});

	it("normalises an untrusted payload", () => {
		expect(toDisplayPrefs(null)).toEqual(DEFAULT_DISPLAY_PREFS);
		expect(toDisplayPrefs({ higherContrast: true, alwaysShowScrollbars: "yes", evil: true })).toEqual(
			{ ...DEFAULT_DISPLAY_PREFS, higherContrast: true },
		);
	});

	it("round-trips the argv codec and ignores unknown names", () => {
		const prefs = { ...DEFAULT_DISPLAY_PREFS, emphasizeTextCursor: true, alwaysShowScrollbars: true };
		expect(decodeDisplayPrefs(encodeDisplayPrefs(prefs))).toEqual(prefs);
		expect(encodeDisplayPrefs(DEFAULT_DISPLAY_PREFS)).toBe("");
		expect(decodeDisplayPrefs("bogus,;rm -rf")).toEqual(DEFAULT_DISPLAY_PREFS);
		expect(decodeDisplayPrefs(undefined)).toEqual(DEFAULT_DISPLAY_PREFS);
	});

	it("paints nothing when every preference is off", () => {
		const paint = resolveDisplayPaint(DEFAULT_DISPLAY_PREFS, themes[ThemeName.DefaultLight]);
		expect(Object.values(paint.attributes).every((v) => v === null)).toBe(true);
		expect(paint.vars).toEqual({});
	});

	it("stamps each attribute and layers contrast overrides only for higher contrast", () => {
		const paint = resolveDisplayPaint(
			{ higherContrast: true, emphasizeTextCursor: true, alwaysShowScrollbars: true },
			themes[ThemeName.DefaultDark],
		);
		expect(paint.attributes[DisplayAttribute.Contrast]).toBe(DisplayAttributeValue.More);
		expect(paint.attributes[DisplayAttribute.TextEmphasis]).toBe(DisplayAttributeValue.On);
		expect(paint.attributes[DisplayAttribute.Scrollbars]).toBe(DisplayAttributeValue.Always);
		expect(Object.keys(paint.vars)).toContain("--color-border-default");
	});
});
