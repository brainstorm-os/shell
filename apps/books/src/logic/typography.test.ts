import { FontRole, SYSTEM_TYPOGRAPHY, type TypographyDef } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_TYPOGRAPHY,
	LEADING_MAX,
	LEADING_MIN,
	MEASURE_MAX,
	MEASURE_MIN,
	ReadingFamily,
	ReadingTheme,
	SIZE_MAX,
	SIZE_MIN,
	charsPerPageBudget,
	clampTypography,
	isReadingFamily,
	isReadingTheme,
	parseTypography,
	readerCssVars,
	resolveReadingFontFamily,
	serializeTypography,
	stepLeading,
	stepMeasure,
	stepSize,
	withFamily,
	withSize,
	withTheme,
} from "./typography";

describe("clampTypography", () => {
	it("clamps numeric axes into their bounds", () => {
		const out = clampTypography({
			family: ReadingFamily.Serif,
			size: 99,
			leading: 5,
			measure: 1000,
			theme: ReadingTheme.Sepia,
		});
		expect(out.size).toBe(SIZE_MAX);
		expect(out.leading).toBe(LEADING_MAX);
		expect(out.measure).toBe(MEASURE_MAX);
	});

	it("clamps below the floor too", () => {
		const out = clampTypography({
			family: ReadingFamily.Serif,
			size: 1,
			leading: 0,
			measure: 1,
			theme: ReadingTheme.Dark,
		});
		expect(out.size).toBe(SIZE_MIN);
		expect(out.leading).toBe(LEADING_MIN);
		expect(out.measure).toBe(MEASURE_MIN);
	});

	it("falls back to defaults for invalid enums", () => {
		const out = clampTypography({
			family: "wingdings" as ReadingFamily,
			size: 18,
			leading: 1.6,
			measure: 66,
			theme: "neon" as ReadingTheme,
		});
		expect(out.family).toBe(DEFAULT_TYPOGRAPHY.family);
		expect(out.theme).toBe(DEFAULT_TYPOGRAPHY.theme);
	});

	it("is idempotent", () => {
		const once = clampTypography({ ...DEFAULT_TYPOGRAPHY, size: 21 });
		expect(clampTypography(once)).toEqual(once);
	});

	it("snaps size to the step ladder", () => {
		expect(clampTypography({ ...DEFAULT_TYPOGRAPHY, size: 19 }).size).toBe(20);
	});

	it("rounds leading to one decimal (no float dust)", () => {
		const out = stepLeading(DEFAULT_TYPOGRAPHY, 1);
		expect(out.leading).toBe(1.7);
	});
});

describe("step + with mutators", () => {
	it("steps size up and down within bounds", () => {
		expect(stepSize(DEFAULT_TYPOGRAPHY, 1).size).toBe(DEFAULT_TYPOGRAPHY.size + 2);
		const big = withSize(DEFAULT_TYPOGRAPHY, SIZE_MAX);
		expect(stepSize(big, 1).size).toBe(SIZE_MAX);
	});

	it("steps leading and measure", () => {
		expect(stepLeading(DEFAULT_TYPOGRAPHY, -1).leading).toBe(1.5);
		expect(stepMeasure(DEFAULT_TYPOGRAPHY, 1).measure).toBe(DEFAULT_TYPOGRAPHY.measure + 5);
	});

	it("sets family and theme", () => {
		expect(withFamily(DEFAULT_TYPOGRAPHY, ReadingFamily.Mono).family).toBe(ReadingFamily.Mono);
		expect(withTheme(DEFAULT_TYPOGRAPHY, ReadingTheme.Dark).theme).toBe(ReadingTheme.Dark);
	});
});

describe("guards", () => {
	it("recognises valid families and themes", () => {
		expect(isReadingFamily(ReadingFamily.Sans)).toBe(true);
		expect(isReadingFamily("nope")).toBe(false);
		expect(isReadingTheme(ReadingTheme.Sepia)).toBe(true);
		expect(isReadingTheme(42)).toBe(false);
	});
});

describe("resolveReadingFontFamily", () => {
	it("returns the named stack for non-system families", () => {
		expect(resolveReadingFontFamily({ ...DEFAULT_TYPOGRAPHY, family: ReadingFamily.Serif })).toMatch(
			/Georgia/,
		);
		expect(resolveReadingFontFamily({ ...DEFAULT_TYPOGRAPHY, family: ReadingFamily.Mono })).toMatch(
			/monospace/,
		);
	});

	it("binds System to the Typography render-application body role", () => {
		const typo: TypographyDef = {
			...SYSTEM_TYPOGRAPHY,
			fonts: {
				...SYSTEM_TYPOGRAPHY.fonts,
				[FontRole.Body]: { stack: "Charter, serif" },
			},
		};
		expect(resolveReadingFontFamily(DEFAULT_TYPOGRAPHY, typo)).toBe("Charter, serif");
	});

	it("falls back to the system body stack with no Typography bound", () => {
		expect(resolveReadingFontFamily(DEFAULT_TYPOGRAPHY)).toBe(
			SYSTEM_TYPOGRAPHY.fonts[FontRole.Body].stack,
		);
	});
});

describe("charsPerPageBudget", () => {
	it("returns a positive budget", () => {
		expect(charsPerPageBudget(DEFAULT_TYPOGRAPHY, 600, 700)).toBeGreaterThan(0);
	});

	it("shrinks the budget when the font grows (re-pagination driver)", () => {
		const small = charsPerPageBudget({ ...DEFAULT_TYPOGRAPHY, size: SIZE_MIN }, 600, 700);
		const large = charsPerPageBudget({ ...DEFAULT_TYPOGRAPHY, size: SIZE_MAX }, 600, 700);
		expect(large).toBeLessThan(small);
	});

	it("caps columns at the measure", () => {
		const narrow = charsPerPageBudget({ ...DEFAULT_TYPOGRAPHY, measure: MEASURE_MIN }, 2000, 700);
		const wide = charsPerPageBudget({ ...DEFAULT_TYPOGRAPHY, measure: MEASURE_MAX }, 2000, 700);
		expect(narrow).toBeLessThan(wide);
	});

	it("taller leading reduces line count and so the budget", () => {
		const tight = charsPerPageBudget({ ...DEFAULT_TYPOGRAPHY, leading: LEADING_MIN }, 600, 700);
		const loose = charsPerPageBudget({ ...DEFAULT_TYPOGRAPHY, leading: LEADING_MAX }, 600, 700);
		expect(loose).toBeLessThan(tight);
	});

	it("never falls below the floor for a tiny area", () => {
		expect(charsPerPageBudget(DEFAULT_TYPOGRAPHY, 1, 1)).toBeGreaterThanOrEqual(80);
	});
});

describe("readerCssVars", () => {
	it("emits the reader custom properties", () => {
		const vars = readerCssVars({ ...DEFAULT_TYPOGRAPHY, size: 20, leading: 1.8, measure: 70 });
		expect(vars["--reader-font-size"]).toBe("20px");
		expect(vars["--reader-leading"]).toBe("1.8");
		expect(vars["--reader-measure"]).toBe("70ch");
		expect(vars["--reader-font-family"].length).toBeGreaterThan(0);
	});
});

describe("serialize / parse round-trip", () => {
	it("round-trips a clamped snapshot", () => {
		const settings = clampTypography({
			family: ReadingFamily.Serif,
			size: 22,
			leading: 1.9,
			measure: 75,
			theme: ReadingTheme.Sepia,
		});
		expect(parseTypography(serializeTypography(settings))).toEqual(settings);
	});

	it("defaults on empty / nullish input", () => {
		expect(parseTypography(null)).toEqual(DEFAULT_TYPOGRAPHY);
		expect(parseTypography("")).toEqual(DEFAULT_TYPOGRAPHY);
		expect(parseTypography(undefined)).toEqual(DEFAULT_TYPOGRAPHY);
	});

	it("defaults on non-JSON and non-object input", () => {
		expect(parseTypography("not json")).toEqual(DEFAULT_TYPOGRAPHY);
		expect(parseTypography("[1,2,3]")).toEqual(DEFAULT_TYPOGRAPHY);
		expect(parseTypography("42")).toEqual(DEFAULT_TYPOGRAPHY);
	});

	it("is forward-tolerant: keeps known fields, drops unknown, clamps", () => {
		const raw = JSON.stringify({
			family: ReadingFamily.Mono,
			size: 999,
			leading: 1.4,
			measure: 60,
			theme: ReadingTheme.Dark,
			futureAxis: "ignored",
		});
		const parsed = parseTypography(raw);
		expect(parsed.family).toBe(ReadingFamily.Mono);
		expect(parsed.size).toBe(SIZE_MAX);
		expect(parsed.leading).toBe(1.4);
		expect(parsed.theme).toBe(ReadingTheme.Dark);
	});

	it("falls back per-field for malformed values", () => {
		const raw = JSON.stringify({ family: 5, size: "big", leading: null, theme: {} });
		expect(parseTypography(raw)).toEqual(DEFAULT_TYPOGRAPHY);
	});
});
