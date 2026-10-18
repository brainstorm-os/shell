import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_SPELLCHECK_LANGUAGES,
	type SpellcheckSession,
	enableSessionSpellcheck,
	getChosenSpellcheckLanguages,
	resolveEffectiveSpellCheckLanguages,
	resolveSpellCheckLanguages,
	setChosenSpellcheckLanguages,
	spellcheckContextFromParams,
} from "./spellcheck";

describe("resolveSpellCheckLanguages", () => {
	const AVAILABLE = ["en-US", "en-GB", "de", "fr", "es"];

	it("keeps the user's preferred order, dropping unsupported tags", () => {
		expect(resolveSpellCheckLanguages(["fr", "klingon", "de"], AVAILABLE)).toEqual(["fr", "de"]);
	});

	it("de-duplicates while preserving first occurrence", () => {
		expect(resolveSpellCheckLanguages(["de", "fr", "de"], AVAILABLE)).toEqual(["de", "fr"]);
	});

	it("falls back to the default when nothing preferred is supported", () => {
		expect(resolveSpellCheckLanguages(["klingon", "sjn"], AVAILABLE)).toEqual([
			...DEFAULT_SPELLCHECK_LANGUAGES,
		]);
	});

	it("drops the default too when it is not in the available list", () => {
		expect(resolveSpellCheckLanguages(["klingon"], ["de", "fr"])).toEqual([]);
	});

	it("returns [] when the platform reports no available list (macOS auto-detect)", () => {
		expect(resolveSpellCheckLanguages(["en-US", "de"], [])).toEqual([]);
	});
});

describe("enableSessionSpellcheck", () => {
	const makeSession = (available: string[]): SpellcheckSession & { calls: { langs?: string[] } } => {
		const calls: { langs?: string[] } = {};
		return {
			calls,
			availableSpellCheckerLanguages: available,
			setSpellCheckerEnabled: vi.fn(),
			setSpellCheckerLanguages: vi.fn((langs: string[]) => {
				calls.langs = langs;
			}),
		};
	};

	it("enables the checker and sets the resolved languages", () => {
		const session = makeSession(["en-US", "de"]);
		enableSessionSpellcheck(session, ["de", "en-US"]);
		expect(session.setSpellCheckerEnabled).toHaveBeenCalledWith(true);
		expect(session.calls.langs).toEqual(["de", "en-US"]);
	});

	it("enables but never sets languages on macOS (empty available list)", () => {
		const session = makeSession([]);
		enableSessionSpellcheck(session, ["en-US"]);
		expect(session.setSpellCheckerEnabled).toHaveBeenCalledWith(true);
		expect(session.setSpellCheckerLanguages).not.toHaveBeenCalled();
	});

	it("is idempotent per session (configures exactly once)", () => {
		const session = makeSession(["en-US"]);
		enableSessionSpellcheck(session, ["en-US"]);
		enableSessionSpellcheck(session, ["en-US"]);
		expect(session.setSpellCheckerEnabled).toHaveBeenCalledTimes(1);
	});
});

describe("spellcheckContextFromParams", () => {
	const base = {
		misspelledWord: "teh",
		dictionarySuggestions: ["the", "tech"],
		isEditable: true,
		x: 5,
		y: 7,
	};

	it("maps an editable misspelling to a renderer context", () => {
		expect(spellcheckContextFromParams(base)).toEqual({
			word: "teh",
			suggestions: ["the", "tech"],
			x: 5,
			y: 7,
		});
	});

	it("returns null when the target is not editable", () => {
		expect(spellcheckContextFromParams({ ...base, isEditable: false })).toBeNull();
	});

	it("returns null when there is no misspelled word", () => {
		expect(spellcheckContextFromParams({ ...base, misspelledWord: "" })).toBeNull();
	});
});

describe("resolveEffectiveSpellCheckLanguages (B11.31)", () => {
	it("prefers the user's choice, in order, filtered to what's available", () => {
		expect(
			resolveEffectiveSpellCheckLanguages(["fr", "xx", "de"], ["en-US"], ["en-US", "de", "fr"]),
		).toEqual(["fr", "de"]);
	});

	it("falls back to the OS order when nothing chosen is available (or nothing is chosen)", () => {
		expect(resolveEffectiveSpellCheckLanguages(["xx"], ["de"], ["en-US", "de"])).toEqual(["de"]);
		expect(resolveEffectiveSpellCheckLanguages(null, ["de"], ["en-US", "de"])).toEqual(["de"]);
	});

	it("never sets a list on macOS (no available dictionaries)", () => {
		expect(resolveEffectiveSpellCheckLanguages(["de"], ["de"], [])).toEqual([]);
	});
});

describe("setChosenSpellcheckLanguages (B11.31)", () => {
	it("re-applies the choice live to every enabled session, and null restores the OS order", () => {
		const make = () => {
			const setSpellCheckerLanguages = vi.fn();
			return {
				availableSpellCheckerLanguages: ["en-US", "de", "fr"],
				setSpellCheckerEnabled: vi.fn(),
				setSpellCheckerLanguages,
			};
		};
		const a = make();
		const b = make();
		enableSessionSpellcheck(a, ["en-US"]);
		enableSessionSpellcheck(b, ["en-US"]);
		setChosenSpellcheckLanguages(["fr", "de"]);
		expect(getChosenSpellcheckLanguages()).toEqual(["fr", "de"]);
		expect(a.setSpellCheckerLanguages).toHaveBeenLastCalledWith(["fr", "de"]);
		expect(b.setSpellCheckerLanguages).toHaveBeenLastCalledWith(["fr", "de"]);
		setChosenSpellcheckLanguages(null);
		expect(getChosenSpellcheckLanguages()).toBeNull();
		expect(a.setSpellCheckerLanguages).toHaveBeenLastCalledWith(["en-US"]);
	});
});
