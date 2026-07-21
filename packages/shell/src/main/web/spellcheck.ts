/**
 * Spellcheck engine config (B11.16a, OQ-SP-1). Brainstorm uses Chromium's
 * built-in spellchecker on each sandboxed app's renderer session — squiggles +
 * OS/hunspell dictionaries for free, ~zero bundle. The shell enables it per app
 * session at window-create (apps declare nothing, mirroring the shell-injected
 * `bs-find-bar` / `.header-nav` chrome); only elements that opt in
 * (`spellcheck=true` / `contentEditable` — see B11.16b) are actually checked.
 *
 * The misspelled word + suggestions surface on the main-process `context-menu`
 * event; B11.16c ferries them to the sandboxed app over a fail-closed
 * `editor.spellcheck.*` capability so the menu renders through fancy-menus
 * (never Chromium's native menu).
 *
 * `enableSessionSpellcheck` takes an injected session subset (not the live
 * Electron `Session`) so the whole module is unit-testable without Electron —
 * the *decision* (which languages) is the pure `resolveSpellCheckLanguages`.
 */

import type { SpellcheckContext } from "@brainstorm-os/sdk-types";
import type { Session } from "electron";

/** Shell → renderer: a right-click landed on a misspelled word; carries the
 *  word + Chromium suggestions + the point to open the menu at. */
export const SPELLCHECK_CONTEXT_CHANNEL = "app:spellcheck-context" as const;
/** Renderer → shell: apply the chosen replacement to the calling renderer's
 *  current misspelling selection. */
export const SPELLCHECK_APPLY_CHANNEL = "app:spellcheck-apply" as const;

/** The subset of Electron's `context-menu` event params this feature reads. */
export type SpellcheckContextMenuParams = {
	misspelledWord: string;
	dictionarySuggestions: string[];
	isEditable: boolean;
	x: number;
	y: number;
};

/**
 * Map a `context-menu` event's params to the renderer payload, or `null` when
 * there is nothing to offer (not editable, or no misspelled word under the
 * cursor). Pure — the Electron listener wiring is in `launch-setup.ts`.
 */
export function spellcheckContextFromParams(
	params: SpellcheckContextMenuParams,
): SpellcheckContext | null {
	if (!params.isEditable || params.misspelledWord.length === 0) return null;
	return {
		word: params.misspelledWord,
		suggestions: params.dictionarySuggestions,
		x: params.x,
		y: params.y,
	};
}

/** Fallback when nothing in the user's preferred list is a supported dictionary
 *  (or the platform reports no list). US English is the source-language floor. */
export const DEFAULT_SPELLCHECK_LANGUAGES: readonly string[] = ["en-US"];

/**
 * Resolve which languages to hand the hunspell spellchecker, given the user's
 * `preferred` BCP-47 tags (OS preference order) and the platform's `available`
 * dictionary list (`session.availableSpellCheckerLanguages`).
 *
 * Keeps `preferred` order, drops unsupported tags + duplicates, and falls back
 * to {@link DEFAULT_SPELLCHECK_LANGUAGES} (filtered to what's available) when the
 * intersection is empty. An empty `available` (macOS — the OS speller
 * auto-detects and ignores the list) yields `[]`, which the caller passes
 * straight through as the documented no-op.
 */
export function resolveSpellCheckLanguages(
	preferred: readonly string[],
	available: readonly string[],
): string[] {
	if (available.length === 0) return [];
	const supported = new Set(available);
	const seen = new Set<string>();
	const result: string[] = [];
	const take = (langs: readonly string[]): void => {
		for (const lang of langs) {
			if (supported.has(lang) && !seen.has(lang)) {
				seen.add(lang);
				result.push(lang);
			}
		}
	};
	take(preferred);
	if (result.length === 0) take(DEFAULT_SPELLCHECK_LANGUAGES);
	return result;
}

/** The Electron `Session` surface this module drives — narrowed so the applier
 *  is injectable with a fake in tests. `availableSpellCheckerLanguages` is a
 *  getter on the real session. */
export type SpellcheckSession = Pick<
	Session,
	"setSpellCheckerEnabled" | "setSpellCheckerLanguages" | "availableSpellCheckerLanguages"
>;

/** Session surface for hydrating the custom dictionary (B11.17a). */
export type DictionarySession = Pick<Session, "addWordToSpellCheckerDictionary">;

/** Sessions whose custom dictionary has been hydrated from the vault store —
 *  app renderers share `session.defaultSession`, so hydrate once. */
const hydratedDictionarySessions = new WeakSet<DictionarySession>();

/**
 * Hydrate `words` (the active vault's persisted custom dictionary, B11.17a) into
 * `session` once. Idempotent per session — re-launches don't re-add. Note: a
 * vault SWITCH does not re-hydrate (the shared session persists); cross-vault
 * re-hydration is a documented follow-up.
 */
export function hydrateSessionDictionary(
	session: DictionarySession,
	words: readonly string[],
): void {
	if (hydratedDictionarySessions.has(session)) return;
	hydratedDictionarySessions.add(session);
	for (const word of words) session.addWordToSpellCheckerDictionary(word);
}

/** Sessions already configured — Brainstorm app renderers share
 *  `session.defaultSession`, so the per-view factory would otherwise re-run this
 *  on every launch. A WeakSet so a discarded session is collectable. */
const configuredSpellcheckSessions = new WeakSet<SpellcheckSession>();

/**
 * Enable Chromium's spellchecker on `session` (idempotent per session).
 * `preferredLanguages` is the OS preference order (`app.getPreferredSystemLanguages()`),
 * injected so this needs no Electron import. On macOS the available list is
 * empty (the OS speller auto-detects) so no language list is set.
 */
export function enableSessionSpellcheck(
	session: SpellcheckSession,
	preferredLanguages: readonly string[],
): void {
	if (configuredSpellcheckSessions.has(session)) return;
	configuredSpellcheckSessions.add(session);
	session.setSpellCheckerEnabled(true);
	const languages = resolveSpellCheckLanguages(
		preferredLanguages,
		session.availableSpellCheckerLanguages,
	);
	if (languages.length > 0) session.setSpellCheckerLanguages(languages);
}
