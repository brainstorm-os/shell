import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	MAX_SPELLCHECK_LANGUAGES,
	coerceLanguageList,
	readSpellcheckLanguages,
	spellcheckLanguagesPath,
	writeSpellcheckLanguages,
} from "./spellcheck-languages-store";

describe("coerceLanguageList", () => {
	it("keeps order, drops junk + duplicates, caps the length", () => {
		expect(coerceLanguageList(["de", "en-US", "de", 3, "../x", "fr-CA"])).toEqual([
			"de",
			"en-US",
			"fr-CA",
		]);
		const many = Array.from({ length: 20 }, (_, i) => `l${String.fromCharCode(97 + i)}`);
		expect(coerceLanguageList(many)).toHaveLength(MAX_SPELLCHECK_LANGUAGES);
	});

	it("reads anything that isn't a list as 'follow the OS'", () => {
		expect(coerceLanguageList({ de: true })).toBeNull();
		expect(coerceLanguageList(null)).toBeNull();
	});
});

describe("spellcheck languages store", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "bs-spell-langs-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("round-trips a choice and removes the file for null", async () => {
		expect(await readSpellcheckLanguages(dir)).toBeNull();
		await writeSpellcheckLanguages(dir, ["fr", "de"]);
		expect(JSON.parse(await readFile(spellcheckLanguagesPath(dir), "utf8"))).toEqual(["fr", "de"]);
		expect(await readSpellcheckLanguages(dir)).toEqual(["fr", "de"]);
		await writeSpellcheckLanguages(dir, null);
		expect(await readSpellcheckLanguages(dir)).toBeNull();
	});

	it("reads a corrupt file as 'follow the OS'", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await writeFile(spellcheckLanguagesPath(dir), "{not json", "utf8");
		expect(await readSpellcheckLanguages(dir)).toBeNull();
		warn.mockRestore();
	});
});
