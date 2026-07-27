import { describe, expect, it } from "vitest";
import {
	AnalyticsErrorScope,
	AnalyticsEvent,
	AnalyticsProp,
	RESERVED_AMPLITUDE_FIELDS,
	parseLocale,
} from "./events";

describe("parseLocale", () => {
	it("splits language + region from a BCP-47 tag", () => {
		expect(parseLocale("en-US")).toEqual({ locale: "en-US", language: "en", region: "US" });
		expect(parseLocale("de-DE")).toEqual({ locale: "de-DE", language: "de", region: "DE" });
	});

	it("normalizes underscore separators and casing", () => {
		expect(parseLocale("pt_br")).toEqual({ locale: "pt_br", language: "pt", region: "BR" });
	});

	it("skips a script subtag to find the region", () => {
		expect(parseLocale("zh-Hans-CN")).toEqual({
			locale: "zh-Hans-CN",
			language: "zh",
			region: "CN",
		});
	});

	it("accepts a UN M49 numeric region", () => {
		expect(parseLocale("es-419")).toEqual({ locale: "es-419", language: "es", region: "419" });
	});

	it("returns a language-only result when there is no region", () => {
		expect(parseLocale("fr")).toEqual({ locale: "fr", language: "fr", region: "" });
	});

	it("returns null for empty / missing input", () => {
		expect(parseLocale("")).toBeNull();
		expect(parseLocale(undefined)).toBeNull();
		expect(parseLocale(null)).toBeNull();
	});
});

describe("analytics taxonomy", () => {
	it("names events and props as stable wire strings", () => {
		expect(AnalyticsEvent.ErrorEncountered).toBe("Error Encountered");
		expect(AnalyticsEvent.AppLaunched).toBe("App Launched");
		expect(AnalyticsProp.AppName).toBe("app_name");
		expect(AnalyticsProp.Region).toBe("bs_region");
		expect(AnalyticsErrorScope.VaultCreate).toBe("vault_create");
	});
});

describe("reserved Amplitude field names", () => {
	it("no AnalyticsProp may shadow an Amplitude built-in", () => {
		// The bug this pins: `app_version`, `platform`, `os_version`, `language`
		// and `region` were all custom properties named exactly like Amplitude's
		// own fields. The stock charts then reported OUR value instead of
		// Amplitude's — Version Composition showed the sandboxed APP's version
		// (0.1.0) for app renderers and `(none)` for shell ones, so the real
		// shell release appeared nowhere at all.
		const reserved = new Set(RESERVED_AMPLITUDE_FIELDS);
		const offenders = Object.entries(AnalyticsProp)
			.filter(([, wire]) => reserved.has(wire))
			.map(([name, wire]) => `${name} → "${wire}"`);
		expect(
			offenders,
			"prefix it (bs_…) — a custom property named like an Amplitude built-in silently shadows the built-in in every stock chart",
		).toEqual([]);
	});

	it("the five that used to collide are namespaced", () => {
		expect(AnalyticsProp.AppVersion).toBe("bs_app_version");
		expect(AnalyticsProp.Platform).toBe("bs_platform");
		expect(AnalyticsProp.OsVersion).toBe("bs_os_version");
		expect(AnalyticsProp.Language).toBe("bs_language");
		expect(AnalyticsProp.Region).toBe("bs_region");
	});

	it("leaves the non-colliding names alone — renaming them would break history for nothing", () => {
		expect(AnalyticsProp.Surface).toBe("surface");
		expect(AnalyticsProp.ShellVersion).toBe("shell_version");
		expect(AnalyticsProp.AppId).toBe("app_id");
		expect(AnalyticsProp.ErrorScope).toBe("error_scope");
	});
});
