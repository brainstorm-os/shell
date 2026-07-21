import type { PropertyDef } from "@brainstorm-os/sdk-types";
import { DateGranularity, PropertyFormat, ValueType } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	dateFormatter,
	editScalar,
	formatDate,
	formatDuration,
	formatNumber,
	formatRelativeDate,
	formatScalar,
	isValidFormatted,
	numberFormatter,
	parseDateInput,
	parseNaturalDate,
	parseNumberInput,
	parseScalar,
} from "./format";

function def(over: Partial<PropertyDef> & { valueType: ValueType }): PropertyDef {
	return {
		key: "prop_x",
		name: "X",
		icon: null,
		...over,
	};
}

describe("formatScalar", () => {
	it("returns the string as-is for text + entityRef value types", () => {
		expect(formatScalar(def({ valueType: ValueType.Text }), "hi")).toBe("hi");
		expect(
			formatScalar(def({ valueType: ValueType.Text, format: PropertyFormat.Url }), "https://x"),
		).toBe("https://x");
		expect(
			formatScalar(def({ valueType: ValueType.Text, format: PropertyFormat.Email }), "a@b"),
		).toBe("a@b");
		expect(formatScalar(def({ valueType: ValueType.EntityRef }), "ent_xyz")).toBe("ent_xyz");
	});

	it("returns the empty string for null text values", () => {
		expect(formatScalar(def({ valueType: ValueType.Text }), null)).toBe("");
	});

	it("formats Boolean as ✓ / empty", () => {
		expect(formatScalar(def({ valueType: ValueType.Boolean }), true)).toBe("✓");
		expect(formatScalar(def({ valueType: ValueType.Boolean }), false)).toBe("");
	});

	it("returns the empty string for null EntityRef", () => {
		expect(formatScalar(def({ valueType: ValueType.EntityRef }), null)).toBe("");
	});
});

describe("editScalar", () => {
	it("edits a number as its raw value, never the formatted display", () => {
		// A currency display ("$25,000") or grouped number ("25,000") can't load
		// into <input type=number>; the editor must pre-fill the raw value.
		const currency = def({
			valueType: ValueType.Number,
			format: PropertyFormat.Currency,
			currency: "USD",
		});
		expect(formatScalar(currency, 25000, { locale: "en-US" })).toContain("$");
		expect(editScalar(currency, 25000)).toBe("25000");
		expect(editScalar(def({ valueType: ValueType.Number }), 25000)).toBe("25000");
		expect(
			editScalar(def({ valueType: ValueType.Number, format: PropertyFormat.Percent }), 0.25),
		).toBe("0.25");
		expect(editScalar(def({ valueType: ValueType.Number }), null)).toBe("");
	});

	it("edits text/url as its display (identity)", () => {
		expect(editScalar(def({ valueType: ValueType.Text }), "Acme")).toBe("Acme");
		expect(
			editScalar(def({ valueType: ValueType.Text, format: PropertyFormat.Url }), "https://x"),
		).toBe("https://x");
	});
});

describe("formatNumber", () => {
	it("returns the empty string for null", () => {
		expect(formatNumber(null, def({ valueType: ValueType.Number }))).toBe("");
	});

	it("formats a plain number locale-aware", () => {
		expect(formatNumber(1234.5, def({ valueType: ValueType.Number }), { locale: "en-US" })).toBe(
			"1,234.5",
		);
	});

	it("respects the precision modifier", () => {
		expect(
			formatNumber(Math.PI, def({ valueType: ValueType.Number, precision: 2 }), { locale: "en-US" }),
		).toBe("3.14");
	});

	it("formats Percent", () => {
		expect(
			formatNumber(0.25, def({ valueType: ValueType.Number, format: PropertyFormat.Percent }), {
				locale: "en-US",
			}),
		).toBe("25%");
	});

	it("formats Currency using the declared ISO code", () => {
		expect(
			formatNumber(
				99.5,
				def({
					valueType: ValueType.Number,
					format: PropertyFormat.Currency,
					currency: "EUR",
				}),
				{ locale: "en-US" },
			),
		).toContain("€");
	});

	it("falls back to a plain numeric + code when the currency string is invalid", () => {
		const out = formatNumber(
			10,
			def({
				valueType: ValueType.Number,
				format: PropertyFormat.Currency,
				currency: "NOT_A_REAL_CODE",
			}),
			{ locale: "en-US" },
		);
		expect(out).toMatch(/NOT_A_REAL_CODE/);
	});

	it("renders a duration-format number as hours + minutes", () => {
		const hours = def({ valueType: ValueType.Number, format: PropertyFormat.Duration });
		expect(formatNumber(1.5, hours)).toBe("1h 30m");
		expect(formatNumber(2, hours)).toBe("2h");
		expect(formatNumber(0.25, hours)).toBe("15m");
	});
});

describe("formatDuration", () => {
	it("returns the empty string for null / non-finite", () => {
		expect(formatDuration(null)).toBe("");
		expect(formatDuration(Number.NaN)).toBe("");
		expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("");
	});

	it("splits whole + fractional hours into h / m", () => {
		expect(formatDuration(3.5)).toBe("3h 30m");
		expect(formatDuration(2)).toBe("2h");
		expect(formatDuration(0.75)).toBe("45m");
		expect(formatDuration(40)).toBe("40h");
	});

	it("rounds fractional hours to the nearest minute", () => {
		// 1.51h = 90.6m → 91m → 1h 31m
		expect(formatDuration(1.51)).toBe("1h 31m");
	});

	it("renders exactly zero as 0h", () => {
		expect(formatDuration(0)).toBe("0h");
	});

	it("keeps a leading minus for negative durations", () => {
		expect(formatDuration(-1.5)).toBe("-1h 30m");
		expect(formatDuration(-0.5)).toBe("-30m");
	});
});

describe("formatDate", () => {
	it("returns the empty string for null", () => {
		expect(formatDate(null)).toBe("");
	});

	it("formats a date-only value without time", () => {
		const out = formatDate({
			at: Date.parse("2026-05-13T00:00:00Z"),
			granularity: DateGranularity.Date,
		});
		expect(out.length).toBeGreaterThan(0);
		expect(out).not.toMatch(/:\d{2}/);
	});

	it("includes the time portion when granularity is datetime", () => {
		const out = formatDate({
			at: Date.parse("2026-05-13T14:30:00Z"),
			granularity: DateGranularity.DateTime,
		});
		expect(out).toMatch(/:\d{2}/);
	});

	it("returns the empty string for an unparseable timestamp", () => {
		expect(formatDate({ at: Number.NaN, granularity: DateGranularity.Date })).toBe("");
	});
});

describe("parseScalar / parseNumberInput / parseDateInput", () => {
	it("trims and returns null for empty text inputs", () => {
		expect(parseScalar(def({ valueType: ValueType.Text }), "")).toBeNull();
		expect(parseScalar(def({ valueType: ValueType.Text }), "   ")).toBeNull();
		expect(parseScalar(def({ valueType: ValueType.Text }), "  hi  ")).toBe("hi");
	});

	it("parses Number with comma + whitespace tolerance", () => {
		expect(parseNumberInput("1,234.5")).toBe(1234.5);
		expect(parseNumberInput("  42  ")).toBe(42);
		expect(parseNumberInput("nope")).toBeNull();
		expect(parseNumberInput("")).toBeNull();
	});

	it("parses Date for ISO + YYYY-MM-DD inputs", () => {
		expect(parseDateInput("")).toBeNull();
		expect(parseDateInput("not-a-date")).toBeNull();
		const dateOnly = parseDateInput("2026-05-13");
		expect(dateOnly?.granularity).toBe(DateGranularity.Date);
		expect(dateOnly && new Date(dateOnly.at).getUTCFullYear()).toBe(2026);
	});

	it("recognises a time component in the date input", () => {
		const withTime = parseDateInput("2026-05-13T14:30:00Z");
		expect(withTime?.granularity).toBe(DateGranularity.DateTime);
	});

	it("parses Boolean only for truthy keywords", () => {
		expect(parseScalar(def({ valueType: ValueType.Boolean }), "true")).toBe(true);
		expect(parseScalar(def({ valueType: ValueType.Boolean }), "YES")).toBe(true);
		expect(parseScalar(def({ valueType: ValueType.Boolean }), "no")).toBe(false);
		expect(parseScalar(def({ valueType: ValueType.Boolean }), "")).toBe(false);
	});
});

describe("parseNaturalDate (B5.9)", () => {
	const NOW = new Date("2026-05-17T09:30:00"); // a Sunday

	it("resolves today / tomorrow / yesterday at midnight", () => {
		expect(new Date(parseNaturalDate("today", undefined, NOW)?.at ?? 0).getDate()).toBe(17);
		expect(new Date(parseNaturalDate("tomorrow", undefined, NOW)?.at ?? 0).getDate()).toBe(18);
		expect(new Date(parseNaturalDate("yesterday", undefined, NOW)?.at ?? 0).getDate()).toBe(16);
		const t = parseNaturalDate("today", undefined, NOW);
		expect(new Date(t?.at ?? 0).getHours()).toBe(0);
	});

	it("resolves relative 'in N days' / 'N days ago' / 'in N weeks'", () => {
		expect(new Date(parseNaturalDate("in 3 days", undefined, NOW)?.at ?? 0).getDate()).toBe(20);
		expect(new Date(parseNaturalDate("5 days ago", undefined, NOW)?.at ?? 0).getDate()).toBe(12);
		expect(new Date(parseNaturalDate("in 2 weeks", undefined, NOW)?.at ?? 0).getDate()).toBe(31);
	});

	it("resolves weekday phrases ('next monday', bare 'friday')", () => {
		// NOW is Sunday (day 0); next monday = +1.
		expect(new Date(parseNaturalDate("next monday", undefined, NOW)?.at ?? 0).getDate()).toBe(18);
		// bare 'friday' = next friday (+5).
		expect(new Date(parseNaturalDate("friday", undefined, NOW)?.at ?? 0).getDate()).toBe(22);
		// 'next week' / 'next month'.
		expect(new Date(parseNaturalDate("next week", undefined, NOW)?.at ?? 0).getDate()).toBe(24);
		expect(new Date(parseNaturalDate("next month", undefined, NOW)?.at ?? 0).getMonth()).toBe(5);
	});

	it("returns null for gibberish", () => {
		expect(parseNaturalDate("whenever", undefined, NOW)).toBeNull();
		expect(parseNaturalDate("", undefined, NOW)).toBeNull();
	});

	it("parseDateInput falls through ISO → natural language", () => {
		expect(parseDateInput("2026-05-13")?.granularity).toBe("date");
		expect(parseDateInput("tomorrow")).not.toBeNull();
		expect(parseDateInput("not a date at all")).toBeNull();
	});
});

describe("Intl formatter memoization (perf)", () => {
	it("returns the same NumberFormat instance for identical options", () => {
		const a = numberFormatter("en-US", { style: "percent" });
		const b = numberFormatter("en-US", { style: "percent" });
		expect(a).toBe(b);
	});

	it("returns a distinct NumberFormat instance for distinct options", () => {
		const pct = numberFormatter("en-US", { style: "percent" });
		const cur = numberFormatter("en-US", { style: "currency", currency: "USD" });
		const deLocale = numberFormatter("de-DE", { style: "percent" });
		const fracs = numberFormatter("en-US", {
			style: "percent",
			minimumFractionDigits: 2,
			maximumFractionDigits: 2,
		});
		expect(pct).not.toBe(cur);
		expect(pct).not.toBe(deLocale);
		expect(pct).not.toBe(fracs);
	});

	it("returns the same DateTimeFormat instance for identical (locale, includeTime)", () => {
		const a = dateFormatter("en-US", true);
		const b = dateFormatter("en-US", true);
		const noTime = dateFormatter("en-US", false);
		expect(a).toBe(b);
		expect(a).not.toBe(noTime);
	});
});

describe("isValidFormatted (B5.9)", () => {
	it("treats empty as valid (optional) regardless of format", () => {
		expect(isValidFormatted(PropertyFormat.Url, "")).toBe(true);
		expect(isValidFormatted(PropertyFormat.Email, "   ")).toBe(true);
	});

	it("validates URLs (bare host accepted via https:// prefix)", () => {
		expect(isValidFormatted(PropertyFormat.Url, "https://example.com")).toBe(true);
		expect(isValidFormatted(PropertyFormat.Url, "example.com")).toBe(true);
		expect(isValidFormatted(PropertyFormat.Url, "not a url")).toBe(false);
	});

	it("validates email + phone shapes", () => {
		expect(isValidFormatted(PropertyFormat.Email, "a@b.co")).toBe(true);
		expect(isValidFormatted(PropertyFormat.Email, "nope")).toBe(false);
		expect(isValidFormatted(PropertyFormat.Phone, "+1 (415) 555-2671")).toBe(true);
		expect(isValidFormatted(PropertyFormat.Phone, "abc")).toBe(false);
	});

	it("no format → always valid", () => {
		expect(isValidFormatted(undefined, "anything")).toBe(true);
	});
});

describe("formatRelativeDate", () => {
	const now = new Date(2026, 5, 1, 12, 0, 0).getTime(); // 2026-06-01 local noon
	const day = (y: number, m: number, d: number) => ({
		at: new Date(y, m, d, 9, 0, 0).getTime(),
		granularity: DateGranularity.Date,
	});

	it("phrases near days relatively", () => {
		expect(formatRelativeDate(day(2026, 5, 1), now)).toBe("Today");
		expect(formatRelativeDate(day(2026, 5, 2), now)).toBe("Tomorrow");
		expect(formatRelativeDate(day(2026, 4, 31), now)).toBe("Yesterday");
		expect(formatRelativeDate(day(2026, 5, 4), now)).toBe("in 3 days");
		expect(formatRelativeDate(day(2026, 4, 29), now)).toBe("3 days ago");
	});

	it("falls back to the absolute date beyond a fortnight", () => {
		const far = day(2026, 8, 1);
		expect(formatRelativeDate(far, now)).toBe(formatDate(far));
	});

	it("returns empty for a null value", () => {
		expect(formatRelativeDate(null, now)).toBe("");
	});
});
