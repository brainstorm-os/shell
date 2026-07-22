import { describe, expect, it } from "vitest";
import { AnalyticsErrorScope, AnalyticsEvent, AnalyticsProp, parseLocale } from "./events";

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
		expect(AnalyticsProp.Region).toBe("region");
		expect(AnalyticsErrorScope.VaultCreate).toBe("vault_create");
	});
});
