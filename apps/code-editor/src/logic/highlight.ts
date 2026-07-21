/**
 * Shiki integration for the code-editor buffer (9.7.2) — now a thin
 * `LanguageKey` adapter over the shared `@brainstorm-os/sdk/code-highlight`
 * tokenizer (extracted at copy two for Notes code blocks, B11.4). The engine
 * — lazy highlighter singleton, theme loading, grammar code-splitting, the
 * test DI seam — lives in the SDK; this file only maps the code-editor's
 * `LanguageKey` enum to Shiki's string language ids and re-exports the bits
 * the editor's overlay + tests consume.
 */

import {
	HighlightTheme,
	type ThemedToken,
	ensureShikiLanguage,
	resetHighlighter,
	setHighlighterFactory,
	tokenizeShiki,
} from "@brainstorm-os/sdk/code-highlight";
import { LanguageKey } from "../types/code-file";

export { HighlightTheme, resetHighlighter, setHighlighterFactory };
export type { ThemedToken };

/**
 * Shiki's bundled language id for each known {@link LanguageKey}. `null`
 * means we deliberately don't highlight (`PlainText`, `Unknown`) — the
 * overlay falls back to a single un-styled span per line. The right side is
 * the lookup key into the SDK's grammar chunk table.
 */
const SHIKI_LANGUAGE: Readonly<Record<LanguageKey, string | null>> = Object.freeze({
	[LanguageKey.TypeScript]: "typescript",
	[LanguageKey.JavaScript]: "javascript",
	[LanguageKey.TSX]: "tsx",
	[LanguageKey.JSX]: "jsx",
	[LanguageKey.JSON]: "json",
	[LanguageKey.JSONC]: "jsonc",
	[LanguageKey.HTML]: "html",
	[LanguageKey.CSS]: "css",
	[LanguageKey.Markdown]: "markdown",
	[LanguageKey.Python]: "python",
	[LanguageKey.Rust]: "rust",
	[LanguageKey.Go]: "go",
	[LanguageKey.Java]: "java",
	[LanguageKey.Shell]: "shellscript",
	[LanguageKey.YAML]: "yaml",
	[LanguageKey.TOML]: "toml",
	[LanguageKey.SQL]: "sql",
	[LanguageKey.Dockerfile]: "docker",
	[LanguageKey.PlainText]: null,
	[LanguageKey.Unknown]: null,
});

export function shikiLanguageId(key: LanguageKey): string | null {
	return SHIKI_LANGUAGE[key] ?? null;
}

/** Ensure the Shiki grammar for {@link key} is loaded — `true` when ready,
 *  `false` for unhighlighted languages or a load failure. */
export function ensureLanguageLoaded(key: LanguageKey): Promise<boolean> {
	return ensureShikiLanguage(shikiLanguageId(key));
}

/** Tokenize `content` with {@link key}'s grammar at {@link theme}. `null`
 *  when the language isn't highlighted or tokenization failed. */
export function tokenizeCode(
	content: string,
	key: LanguageKey,
	theme: HighlightTheme = HighlightTheme.Light,
): Promise<ThemedToken[][] | null> {
	return tokenizeShiki(content, shikiLanguageId(key), theme);
}
