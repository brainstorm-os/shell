/**
 * Spellcheck privileged IPC.
 *
 * B11.16c — the renderer → shell apply path for spellcheck suggestions: the
 * suggestion menu renders in the sandboxed app (fancy-menus); picking a word
 * sends it here and the shell replaces the calling renderer's current
 * misspelling via Electron's native `webContents.replaceMisspelling`.
 * `event.sender` is the trusted source — the replacement only ever touches that
 * renderer's own selection, so no broker capability is involved.
 *
 * B11.17b — the dashboard (privileged renderer, not a sandboxed app, so it uses
 * direct ipcMain not the broker) reads + prunes the per-vault custom dictionary
 * for the Settings manager, and reads the active spellcheck languages.
 *
 * B11.31 — the dashboard also SETS the spellcheck languages: an ordered list
 * from the platform's available dictionaries (or `null` to follow the OS),
 * validated here, persisted per device under userData, and re-applied live to
 * every spellcheck-enabled session.
 */

import { type Session, app, session as electronSession, ipcMain } from "electron";
import { appConfigDir } from "../vault/paths";
import { getActiveVaultSession } from "../vault/session";
import {
	readSpellcheckDictionary,
	removeWordFromList,
	writeSpellcheckDictionary,
} from "../vault/vault-spellcheck-dictionary-store";
import {
	SPELLCHECK_APPLY_CHANNEL,
	enableSessionSpellcheck,
	getChosenSpellcheckLanguages,
	setChosenSpellcheckLanguages,
} from "../web/spellcheck";
import {
	MAX_SPELLCHECK_LANGUAGES,
	readSpellcheckLanguages,
	writeSpellcheckLanguages,
} from "../web/spellcheck-languages-store";

export const SPELLCHECK_LIST_WORDS_CHANNEL = "spellcheck:list-words" as const;
export const SPELLCHECK_REMOVE_WORD_CHANNEL = "spellcheck:remove-word" as const;
export const SPELLCHECK_LANGUAGES_CHANNEL = "spellcheck:languages" as const;
export const SPELLCHECK_SET_LANGUAGES_CHANNEL = "spellcheck:set-languages" as const;

/** Active + available spellcheck languages (empty on macOS — the OS speller
 *  auto-detects and exposes no list), plus the user's explicit choice
 *  (`null` = following the OS preference order). */
export type SpellcheckLanguagesInfo = {
	active: string[];
	available: string[];
	chosen: string[] | null;
};

/** Validate a renderer-supplied choice against the dictionaries this platform
 *  has: `null` (follow the OS) or a non-empty ordered subset of `available`.
 *  Anything else is rejected (`undefined`). Pure. */
export function validateLanguageChoice(
	input: unknown,
	available: readonly string[],
): string[] | null | undefined {
	if (input === null) return null;
	if (!Array.isArray(input) || input.length === 0 || input.length > MAX_SPELLCHECK_LANGUAGES) {
		return undefined;
	}
	const supported = new Set(available);
	const out: string[] = [];
	for (const lang of input) {
		if (typeof lang !== "string" || !supported.has(lang) || out.includes(lang)) return undefined;
		out.push(lang);
	}
	return out;
}

function languagesInfo(ses: Session): SpellcheckLanguagesInfo {
	const chosen = getChosenSpellcheckLanguages();
	return {
		active: ses.getSpellCheckerLanguages(),
		available: ses.availableSpellCheckerLanguages,
		chosen: chosen ? [...chosen] : null,
	};
}

export function registerSpellcheckHandlers(): void {
	void readSpellcheckLanguages(appConfigDir()).then((stored) => {
		if (stored && stored.length > 0) setChosenSpellcheckLanguages(stored);
	});

	ipcMain.on(SPELLCHECK_APPLY_CHANNEL, (event, replacement: unknown) => {
		if (typeof replacement === "string" && replacement.length > 0 && !event.sender.isDestroyed()) {
			event.sender.replaceMisspelling(replacement);
		}
	});

	ipcMain.handle(SPELLCHECK_LIST_WORDS_CHANNEL, async (): Promise<string[]> => {
		const vaultPath = getActiveVaultSession()?.vaultPath;
		return vaultPath ? readSpellcheckDictionary(vaultPath) : [];
	});

	ipcMain.handle(
		SPELLCHECK_REMOVE_WORD_CHANNEL,
		async (_event, word: unknown): Promise<string[]> => {
			const vaultPath = getActiveVaultSession()?.vaultPath;
			if (!vaultPath || typeof word !== "string") {
				return vaultPath ? readSpellcheckDictionary(vaultPath) : [];
			}
			const next = removeWordFromList(await readSpellcheckDictionary(vaultPath), word);
			await writeSpellcheckDictionary(vaultPath, next);
			electronSession.defaultSession.removeWordFromSpellCheckerDictionary(word);
			return next;
		},
	);

	ipcMain.handle(
		SPELLCHECK_LANGUAGES_CHANNEL,
		(): SpellcheckLanguagesInfo => languagesInfo(electronSession.defaultSession),
	);

	ipcMain.handle(
		SPELLCHECK_SET_LANGUAGES_CHANNEL,
		async (_event, input: unknown): Promise<SpellcheckLanguagesInfo> => {
			const ses: Session = electronSession.defaultSession;
			const choice = validateLanguageChoice(input, ses.availableSpellCheckerLanguages);
			if (choice === undefined) return languagesInfo(ses);
			await writeSpellcheckLanguages(appConfigDir(), choice);
			// The dashboard can save before any app window opened — make sure the
			// shared app session is under management so the choice lands on it.
			enableSessionSpellcheck(ses, app.getPreferredSystemLanguages());
			setChosenSpellcheckLanguages(choice);
			return languagesInfo(ses);
		},
	);
}
