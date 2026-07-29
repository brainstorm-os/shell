/**
 * Shared Shiki tokenizer — lazy-loaded syntax highlighting, keyed by Shiki
 * language id (a plain string), reusable across apps.
 *
 * Extracted from the code-editor app (9.7.2) at copy two (Notes code blocks,
 * B11.4) per [[feedback_extract_to_sdk_at_copy_two]]. The code-editor keeps a
 * thin `LanguageKey`→shiki-id adapter on top; Notes maps a `@lexical/code`
 * language name → shiki id and calls in directly. The *tokenizer* is the
 * reusable engine; how an app paints the tokens (textarea overlay vs.
 * contenteditable overlay, citation decoration, etc.) stays app-local.
 *
 * Shiki's full bundle is huge, so we use **core** + the JavaScript regex
 * engine and dynamic-import each grammar chunk the first time a buffer asks
 * for it (Vite needs the literal `import("shiki/langs/<id>.mjs")` specifiers
 * visible to code-split them — hence the static dispatch table, not a
 * computed specifier). Two themes (light + dark) load once at startup so a
 * consumer can follow the shell's `prefers-color-scheme`.
 *
 * The highlighter is a process singleton; once a grammar resolves, later
 * buffers in that language reuse it. A failed grammar load falls back to "no
 * tokens" (the consumer paints plain text) rather than throwing. The factory
 * + chunk loader are DI-able via {@link setHighlighterFactory} for tests;
 * production always uses the defaults.
 */

import {
	type HighlighterCore,
	type LanguageInput,
	type ThemedToken,
	createHighlighterCore,
} from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

export type { ThemedToken } from "shiki/core";

/** The two themes kept loaded — the shell's light/dark binary. Fine-grained
 *  tinting happens in surrounding CSS, not by swapping themes per app theme. */
export enum HighlightTheme {
	Light = "github-light",
	Dark = "github-dark",
}

/**
 * The SHELL-painted appearance for this document, or `null` when no shell
 * painted one (unit tests, detached docs). The preload writes the resolved
 * appearance as `color-scheme` on `<body>` (the `#brainstorm-tokens` style);
 * every app's own stylesheet says `:root { color-scheme: light dark }`, which
 * out-specifies that rule on `<html>` — so `<html>`'s computed value is the
 * constant "light dark" while `<body>` (no competing declaration) carries the
 * real appearance. Consumers resolving a highlight theme MUST prefer this
 * over the OS-level `prefers-color-scheme` media query: the shell theme can
 * disagree with the OS setting, and reading the media query first is exactly
 * how a Dark-appearance shell on a light-mode OS shipped github-light tokens
 * on a near-black editor (dark-sweep 2026-07-29).
 */
export function shellAppearanceDark(): boolean | null {
	if (typeof document === "undefined" || !document.body) return null;
	const scheme = getComputedStyle(document.body).colorScheme?.trim();
	if (scheme === "dark") return true;
	if (scheme === "light") return false;
	return null;
}

/** Grammar-chunk loader: resolve a Shiki language id to its `LanguageInput`,
 *  or `null` when unknown / unavailable (the consumer falls back to plain). */
export type LoadLanguageChunk = (shikiId: string) => Promise<LanguageInput | null>;

/**
 * Static dispatch from a Shiki language id to a dynamic-import call. Vite
 * needs the specifier literal at build time to code-split each grammar into
 * its own chunk — a computed `import(\`…${id}…\`)` ships the whole Shiki
 * bundle into the main chunk instead. Extend this table to support more
 * languages product-wide (every consumer picks them up).
 */
const LANGUAGE_CHUNK_LOADERS: Readonly<Record<string, () => Promise<{ default: LanguageInput }>>> =
	Object.freeze({
		typescript: () => import("shiki/langs/typescript.mjs"),
		javascript: () => import("shiki/langs/javascript.mjs"),
		tsx: () => import("shiki/langs/tsx.mjs"),
		jsx: () => import("shiki/langs/jsx.mjs"),
		json: () => import("shiki/langs/json.mjs"),
		jsonc: () => import("shiki/langs/jsonc.mjs"),
		html: () => import("shiki/langs/html.mjs"),
		css: () => import("shiki/langs/css.mjs"),
		markdown: () => import("shiki/langs/markdown.mjs"),
		python: () => import("shiki/langs/python.mjs"),
		rust: () => import("shiki/langs/rust.mjs"),
		go: () => import("shiki/langs/go.mjs"),
		java: () => import("shiki/langs/java.mjs"),
		cpp: () => import("shiki/langs/cpp.mjs"),
		shellscript: () => import("shiki/langs/shellscript.mjs"),
		yaml: () => import("shiki/langs/yaml.mjs"),
		toml: () => import("shiki/langs/toml.mjs"),
		sql: () => import("shiki/langs/sql.mjs"),
		docker: () => import("shiki/langs/docker.mjs"),
	});

/** True when the SDK ships a grammar chunk for this Shiki id — consumers can
 *  pre-filter (e.g. a language picker) to the supported set. */
export function isHighlightableLanguage(shikiId: string): boolean {
	return shikiId in LANGUAGE_CHUNK_LOADERS;
}

const defaultLoadLanguageChunk: LoadLanguageChunk = async (shikiId) => {
	const loader = LANGUAGE_CHUNK_LOADERS[shikiId];
	if (!loader) return null;
	try {
		const mod = await loader();
		return mod.default;
	} catch (error) {
		console.warn(`[sdk/code-highlight] failed to load shiki grammar "${shikiId}":`, error);
		return null;
	}
};

export type HighlighterFactory = () => Promise<HighlighterCore>;

const defaultHighlighterFactory: HighlighterFactory = async () => {
	const [light, dark] = await Promise.all([
		import("shiki/themes/github-light.mjs").then((m) => m.default),
		import("shiki/themes/github-dark.mjs").then((m) => m.default),
	]);
	return createHighlighterCore({
		themes: [light, dark],
		langs: [],
		engine: createJavaScriptRegexEngine(),
	});
};

let factory: HighlighterFactory = defaultHighlighterFactory;
let loadChunk: LoadLanguageChunk = defaultLoadLanguageChunk;
let highlighterPromise: Promise<HighlighterCore> | null = null;
const loadedLanguages = new Set<string>();
const loadingLanguages = new Map<string, Promise<boolean>>();

/** Swap the highlighter factory + chunk loader. For tests — production always
 *  uses the defaults above. */
export function setHighlighterFactory(
	next: HighlighterFactory,
	nextLoadChunk?: LoadLanguageChunk,
): void {
	factory = next;
	if (nextLoadChunk) loadChunk = nextLoadChunk;
}

/** Drop the singleton + loaded-language caches. Tests call this in cleanup so
 *  a stale highlighter doesn't bleed across suites. Idempotent. */
export function resetHighlighter(): void {
	factory = defaultHighlighterFactory;
	loadChunk = defaultLoadLanguageChunk;
	highlighterPromise = null;
	loadedLanguages.clear();
	loadingLanguages.clear();
}

function getHighlighter(): Promise<HighlighterCore> {
	if (!highlighterPromise) highlighterPromise = factory();
	return highlighterPromise;
}

/**
 * Ensure the Shiki grammar for `shikiId` is loaded. Returns `true` when the
 * highlighter is ready to tokenize this language, `false` for an unknown /
 * empty id OR when the grammar chunk failed to load. Concurrent callers for
 * the same language share one in-flight load.
 */
export async function ensureShikiLanguage(shikiId: string | null | undefined): Promise<boolean> {
	if (!shikiId) return false;
	if (loadedLanguages.has(shikiId)) return true;
	const pending = loadingLanguages.get(shikiId);
	if (pending) return pending;
	const promise = (async () => {
		const input = await loadChunk(shikiId);
		if (!input) return false;
		const hl = await getHighlighter();
		try {
			await hl.loadLanguage(input);
			loadedLanguages.add(shikiId);
			return true;
		} catch (error) {
			console.warn(`[sdk/code-highlight] shiki.loadLanguage("${shikiId}") failed:`, error);
			return false;
		} finally {
			loadingLanguages.delete(shikiId);
		}
	})();
	loadingLanguages.set(shikiId, promise);
	return promise;
}

/**
 * Tokenize `content` with `shikiId`'s grammar at `theme`. Returns `null` when
 * the language isn't highlightable (unknown id / load failure) — the consumer
 * paints unstyled spans. Throws are caught and reported as `null` so a
 * malformed buffer never crashes the caller.
 */
export async function tokenizeShiki(
	content: string,
	shikiId: string | null | undefined,
	theme: HighlightTheme = HighlightTheme.Light,
): Promise<ThemedToken[][] | null> {
	const ready = await ensureShikiLanguage(shikiId);
	if (!ready || !shikiId) return null;
	const hl = await getHighlighter();
	try {
		return hl.codeToTokensBase(content, { lang: shikiId, theme });
	} catch (error) {
		console.warn("[sdk/code-highlight] shiki.codeToTokensBase failed:", error);
		return null;
	}
}
