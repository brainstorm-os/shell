/**
 * B11.31 — the user's chosen spellcheck languages, persisted PER DEVICE at
 * `<userData>/spellcheck-languages.json` (not in the vault: which hunspell
 * dictionaries exist is a property of this machine's Chromium, and a laptop
 * and a desktop can reasonably check different languages over the same vault).
 *
 * `null` means "follow the operating system's preferred languages" — the
 * B11.16 default, and what a missing or corrupt file reads as. Pure I/O + pure
 * list ops; never throws.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const SPELLCHECK_LANGUAGES_FILENAME = "spellcheck-languages.json";

/** Chromium accepts several dictionaries at once; past a handful every word is
 *  checked against all of them and suggestions degrade, so cap the list. */
export const MAX_SPELLCHECK_LANGUAGES = 8;

const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

export function spellcheckLanguagesPath(configDir: string): string {
	return join(configDir, SPELLCHECK_LANGUAGES_FILENAME);
}

/** A clean, ordered, de-duplicated language list, or `null` (follow the OS)
 *  for anything that isn't an array. Non-tag entries are dropped. */
export function coerceLanguageList(parsed: unknown): string[] | null {
	if (!Array.isArray(parsed)) return null;
	const out: string[] = [];
	for (const entry of parsed) {
		if (typeof entry !== "string" || !LANGUAGE_TAG.test(entry) || out.includes(entry)) continue;
		out.push(entry);
		if (out.length === MAX_SPELLCHECK_LANGUAGES) break;
	}
	return out;
}

export async function readSpellcheckLanguages(configDir: string): Promise<string[] | null> {
	try {
		const raw = await readFile(spellcheckLanguagesPath(configDir), "utf8");
		return coerceLanguageList(JSON.parse(raw));
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
			console.warn("[brainstorm] spellcheck-languages.json read failed; following the OS:", error);
		}
		return null;
	}
}

/** Persist the choice; `null` removes the file (back to the OS default). */
export async function writeSpellcheckLanguages(
	configDir: string,
	languages: readonly string[] | null,
): Promise<void> {
	const path = spellcheckLanguagesPath(configDir);
	if (languages === null) {
		await rm(path, { force: true });
		return;
	}
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(languages)}\n`, "utf8");
}
