import { describe, expect, it } from "vitest";
import { regionalToFormatContext, sameFormatContext } from "./format-context";
import { DEFAULT_REGIONAL, DateStylePref, HourCyclePref } from "./shell-prefs";

describe("regionalToFormatContext (12.15 15f)", () => {
	it("uses the UI language as the format locale when no overrides are set", () => {
		expect(regionalToFormatContext("de", DEFAULT_REGIONAL)).toEqual({ locale: "de" });
	});

	it("prefers an explicit numberLocale override over the UI language", () => {
		const ctx = regionalToFormatContext("en", { ...DEFAULT_REGIONAL, numberLocale: "fr-FR" });
		expect(ctx.locale).toBe("fr-FR");
	});

	it("maps the hour cycle to hour12", () => {
		expect(
			regionalToFormatContext("en", { ...DEFAULT_REGIONAL, hourCycle: HourCyclePref.H12 }),
		).toMatchObject({ hour12: true });
		expect(
			regionalToFormatContext("en", { ...DEFAULT_REGIONAL, hourCycle: HourCyclePref.H23 }),
		).toMatchObject({ hour12: false });
	});

	it("leaves hour12 unset for the Auto hour cycle", () => {
		expect(regionalToFormatContext("en", DEFAULT_REGIONAL)).not.toHaveProperty("hour12");
	});

	it("carries an explicit time zone but omits the auto sentinel", () => {
		expect(
			regionalToFormatContext("en", { ...DEFAULT_REGIONAL, timezone: "Asia/Tokyo" }),
		).toMatchObject({ timeZone: "Asia/Tokyo" });
		expect(regionalToFormatContext("en", DEFAULT_REGIONAL)).not.toHaveProperty("timeZone");
	});

	it("combines every override", () => {
		const ctx = regionalToFormatContext("en", {
			hourCycle: HourCyclePref.H23,
			dateStyle: DateStylePref.Long,
			firstDayOfWeek: 1,
			numberLocale: "de-DE",
			timezone: "Europe/Berlin",
		});
		expect(ctx).toEqual({ locale: "de-DE", hour12: false, timeZone: "Europe/Berlin" });
	});
});

describe("sameFormatContext (12.15 15f)", () => {
	it("is true for structurally-equal contexts", () => {
		expect(sameFormatContext({ locale: "de", hour12: true }, { locale: "de", hour12: true })).toBe(
			true,
		);
	});

	it("is false when any field differs", () => {
		expect(sameFormatContext({ locale: "de" }, { locale: "es" })).toBe(false);
		expect(sameFormatContext({ hour12: true }, { hour12: false })).toBe(false);
		expect(sameFormatContext({}, { timeZone: "Asia/Tokyo" })).toBe(false);
	});
});
