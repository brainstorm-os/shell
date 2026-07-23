import { describe, expect, it } from "vitest";
import {
	AVAILABLE_LANGUAGES,
	MACHINE_TRANSLATED_LANGUAGES,
	SOURCE_LANGUAGE,
	isAvailableLanguage,
	languageLabel,
	localeFallbackChain,
} from "./locale-catalog";

describe("locale-catalog", () => {
	it("source language is English and is available", () => {
		expect(SOURCE_LANGUAGE).toBe("en");
		expect(isAvailableLanguage("en")).toBe(true);
		expect(AVAILABLE_LANGUAGES).toContain("en");
	});

	it("isAvailableLanguage rejects unknown tags", () => {
		expect(isAvailableLanguage("zz")).toBe(false);
		expect(isAvailableLanguage("xx")).toBe(false);
	});

	it("ships the seed-pack locales", () => {
		for (const tag of ["es", "de", "fr", "it", "pt"]) {
			expect(isAvailableLanguage(tag)).toBe(true);
		}
	});

	it("English is not flagged machine-translated; seeds are", () => {
		expect(MACHINE_TRANSLATED_LANGUAGES.has("en")).toBe(false);
		for (const tag of ["es", "de", "fr", "it", "pt"]) {
			expect(MACHINE_TRANSLATED_LANGUAGES.has(tag)).toBe(true);
		}
	});

	it("languageLabel returns the autonym (or a static fallback)", () => {
		expect(languageLabel("en")).toBe("English");
		// autonyms via Intl.DisplayNames, else the static fallback.
		expect(["Español", "español"]).toContain(languageLabel("es"));
		expect(languageLabel("de")).toBe("Deutsch");
		expect(["Français", "français"]).toContain(languageLabel("fr"));
		expect(["Italiano", "italiano"]).toContain(languageLabel("it"));
		expect(["Português", "português"]).toContain(languageLabel("pt"));
	});

	it("localeFallbackChain narrows a regional tag down to the source", () => {
		expect(localeFallbackChain("de-AT")).toEqual(["de-AT", "de", "en"]);
		expect(localeFallbackChain("es")).toEqual(["es", "en"]);
		expect(localeFallbackChain("en")).toEqual(["en"]);
	});
});
