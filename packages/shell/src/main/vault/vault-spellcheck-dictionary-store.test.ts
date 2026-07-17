import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeTestDir } from "../test-support/remove-test-dir";
import {
	addWordToList,
	coerceWordList,
	readSpellcheckDictionary,
	removeWordFromList,
	spellcheckDictionaryPath,
	writeSpellcheckDictionary,
} from "./vault-spellcheck-dictionary-store";

describe("addWordToList", () => {
	it("appends a trimmed word", () => {
		expect(addWordToList(["a"], "  b ")).toEqual(["a", "b"]);
	});
	it("rejects blank words", () => {
		expect(addWordToList(["a"], "   ")).toEqual(["a"]);
	});
	it("de-duplicates case-insensitively, keeping the original casing", () => {
		expect(addWordToList(["Brainstorm"], "brainstorm")).toEqual(["Brainstorm"]);
	});
});

describe("removeWordFromList", () => {
	it("removes case-insensitively", () => {
		expect(removeWordFromList(["Brainstorm", "Yjs"], "brainstorm")).toEqual(["Yjs"]);
	});
});

describe("coerceWordList", () => {
	it("keeps only non-empty strings, de-duplicated", () => {
		expect(coerceWordList(["a", "", 3, "A", null, "b"])).toEqual(["a", "b"]);
	});
	it("returns [] for non-array input", () => {
		expect(coerceWordList({ words: ["a"] })).toEqual([]);
	});
});

describe("readSpellcheckDictionary / writeSpellcheckDictionary", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "bs-spell-"));
	});
	afterEach(async () => {
		await removeTestDir(dir);
	});

	it("returns [] when the file is absent", async () => {
		expect(await readSpellcheckDictionary(dir)).toEqual([]);
	});

	it("round-trips a written list", async () => {
		await writeSpellcheckDictionary(dir, ["Brainstorm", "Yjs"]);
		expect(await readSpellcheckDictionary(dir)).toEqual(["Brainstorm", "Yjs"]);
		// stored under shell/<file>
		const onDisk = await readFile(spellcheckDictionaryPath(dir), "utf8");
		expect(JSON.parse(onDisk)).toEqual(["Brainstorm", "Yjs"]);
	});

	it("returns [] for a corrupt file", async () => {
		await writeSpellcheckDictionary(dir, ["x"]);
		await writeFileRaw(spellcheckDictionaryPath(dir), "{not json");
		expect(await readSpellcheckDictionary(dir)).toEqual([]);
	});
});

async function writeFileRaw(path: string, content: string): Promise<void> {
	const { writeFile } = await import("node:fs/promises");
	await writeFile(path, content, "utf8");
}
