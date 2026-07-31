/**
 * Pure language detection from path / MIME / first-line shebang. The
 * long-term keystone the Shiki highlighter dispatches off (Code Editor
 * Stage 9.7, Preview's code renderer 9.20.4) — the detection contract
 * stays fixed while each renderer's paint evolves.
 *
 * Extracted to the SDK because Code Editor (`LanguageKey`) and Preview
 * (`CodeLanguage`) had grown two ~95%-identical detectors with the same
 * string enum values. This is the union of both maps; the two callers
 * differ only in the empty-signal fallback (`Unknown` for the editor,
 * `PlainText` for the read-only preview), expressed via `detectLanguage`'s
 * `fallback` option.
 */

// The enum itself lives in the dependency-free contract leaf (sdk-types) so
// `ProposedCodeFile` can name it; this module stays its canonical import site.
import { CodeLanguage } from "@brainstorm-os/sdk-types";

export { CodeLanguage };

export const CODE_LANGUAGES: readonly CodeLanguage[] = Object.freeze([
	CodeLanguage.TypeScript,
	CodeLanguage.JavaScript,
	CodeLanguage.TSX,
	CodeLanguage.JSX,
	CodeLanguage.JSON,
	CodeLanguage.JSONC,
	CodeLanguage.HTML,
	CodeLanguage.CSS,
	CodeLanguage.Markdown,
	CodeLanguage.Python,
	CodeLanguage.Rust,
	CodeLanguage.Go,
	CodeLanguage.Java,
	CodeLanguage.Shell,
	CodeLanguage.YAML,
	CodeLanguage.TOML,
	CodeLanguage.SQL,
	CodeLanguage.Dockerfile,
	CodeLanguage.PlainText,
	CodeLanguage.Unknown,
]);

export function isCodeLanguage(value: unknown): value is CodeLanguage {
	return typeof value === "string" && (CODE_LANGUAGES as string[]).includes(value);
}

const EXTENSION_MAP: Record<string, CodeLanguage> = {
	ts: CodeLanguage.TypeScript,
	mts: CodeLanguage.TypeScript,
	cts: CodeLanguage.TypeScript,
	tsx: CodeLanguage.TSX,
	js: CodeLanguage.JavaScript,
	mjs: CodeLanguage.JavaScript,
	cjs: CodeLanguage.JavaScript,
	jsx: CodeLanguage.JSX,
	json: CodeLanguage.JSON,
	jsonc: CodeLanguage.JSONC,
	html: CodeLanguage.HTML,
	htm: CodeLanguage.HTML,
	xhtml: CodeLanguage.HTML,
	xml: CodeLanguage.HTML,
	css: CodeLanguage.CSS,
	scss: CodeLanguage.CSS,
	sass: CodeLanguage.CSS,
	less: CodeLanguage.CSS,
	md: CodeLanguage.Markdown,
	mdx: CodeLanguage.Markdown,
	markdown: CodeLanguage.Markdown,
	py: CodeLanguage.Python,
	pyi: CodeLanguage.Python,
	pyx: CodeLanguage.Python,
	rs: CodeLanguage.Rust,
	go: CodeLanguage.Go,
	java: CodeLanguage.Java,
	sh: CodeLanguage.Shell,
	bash: CodeLanguage.Shell,
	zsh: CodeLanguage.Shell,
	fish: CodeLanguage.Shell,
	yaml: CodeLanguage.YAML,
	yml: CodeLanguage.YAML,
	toml: CodeLanguage.TOML,
	sql: CodeLanguage.SQL,
	txt: CodeLanguage.PlainText,
};

const SPECIAL_FILENAMES: Record<string, CodeLanguage> = {
	Dockerfile: CodeLanguage.Dockerfile,
	dockerfile: CodeLanguage.Dockerfile,
	Containerfile: CodeLanguage.Dockerfile,
	"package.json": CodeLanguage.JSON,
	"tsconfig.json": CodeLanguage.JSONC,
	"jsconfig.json": CodeLanguage.JSONC,
	".gitignore": CodeLanguage.PlainText,
	".dockerignore": CodeLanguage.PlainText,
	Makefile: CodeLanguage.Shell,
	makefile: CodeLanguage.Shell,
};

const MIME_MAP: Record<string, CodeLanguage> = {
	"text/x-typescript": CodeLanguage.TypeScript,
	"application/x-typescript": CodeLanguage.TypeScript,
	"application/typescript": CodeLanguage.TypeScript,
	"text/javascript": CodeLanguage.JavaScript,
	"application/javascript": CodeLanguage.JavaScript,
	"application/json": CodeLanguage.JSON,
	"application/xml": CodeLanguage.HTML,
	"text/html": CodeLanguage.HTML,
	"text/css": CodeLanguage.CSS,
	"text/markdown": CodeLanguage.Markdown,
	"text/x-python": CodeLanguage.Python,
	"text/x-rust": CodeLanguage.Rust,
	"text/x-rustsrc": CodeLanguage.Rust,
	"text/x-go": CodeLanguage.Go,
	"text/x-java": CodeLanguage.Java,
	"application/x-sh": CodeLanguage.Shell,
	"text/x-shellscript": CodeLanguage.Shell,
	"text/x-yaml": CodeLanguage.YAML,
	"application/x-yaml": CodeLanguage.YAML,
	"text/x-toml": CodeLanguage.TOML,
	"application/sql": CodeLanguage.SQL,
	"text/plain": CodeLanguage.PlainText,
};

const DISPLAY_LABEL: Record<CodeLanguage, string> = {
	[CodeLanguage.TypeScript]: "TypeScript",
	[CodeLanguage.JavaScript]: "JavaScript",
	[CodeLanguage.TSX]: "TSX",
	[CodeLanguage.JSX]: "JSX",
	[CodeLanguage.JSON]: "JSON",
	[CodeLanguage.JSONC]: "JSON with comments",
	[CodeLanguage.HTML]: "HTML",
	[CodeLanguage.CSS]: "CSS",
	[CodeLanguage.Markdown]: "Markdown",
	[CodeLanguage.Python]: "Python",
	[CodeLanguage.Rust]: "Rust",
	[CodeLanguage.Go]: "Go",
	[CodeLanguage.Java]: "Java",
	[CodeLanguage.Shell]: "Shell",
	[CodeLanguage.YAML]: "YAML",
	[CodeLanguage.TOML]: "TOML",
	[CodeLanguage.SQL]: "SQL",
	[CodeLanguage.Dockerfile]: "Dockerfile",
	[CodeLanguage.PlainText]: "Plain text",
	[CodeLanguage.Unknown]: "Unknown",
};

/** Display label for an inspector "Language" row. Proper-cased; not
 *  user input, so not `t()`-wrapped. */
export function languageDisplayLabel(lang: CodeLanguage): string {
	return DISPLAY_LABEL[lang];
}

/** Shiki's bundled grammar id per {@link CodeLanguage} — the lookup key into
 *  `@brainstorm-os/sdk/code-highlight`'s chunk table. `null` = deliberately
 *  unhighlighted (`PlainText`, `Unknown`); consumers paint plain text.
 *  Extracted from the code-editor's `LanguageKey` adapter at copy two (the
 *  Agent's propose-code-file preview is the second consumer). */
const SHIKI_LANGUAGE_ID: Readonly<Record<CodeLanguage, string | null>> = Object.freeze({
	[CodeLanguage.TypeScript]: "typescript",
	[CodeLanguage.JavaScript]: "javascript",
	[CodeLanguage.TSX]: "tsx",
	[CodeLanguage.JSX]: "jsx",
	[CodeLanguage.JSON]: "json",
	[CodeLanguage.JSONC]: "jsonc",
	[CodeLanguage.HTML]: "html",
	[CodeLanguage.CSS]: "css",
	[CodeLanguage.Markdown]: "markdown",
	[CodeLanguage.Python]: "python",
	[CodeLanguage.Rust]: "rust",
	[CodeLanguage.Go]: "go",
	[CodeLanguage.Java]: "java",
	[CodeLanguage.Shell]: "shellscript",
	[CodeLanguage.YAML]: "yaml",
	[CodeLanguage.TOML]: "toml",
	[CodeLanguage.SQL]: "sql",
	[CodeLanguage.Dockerfile]: "docker",
	[CodeLanguage.PlainText]: null,
	[CodeLanguage.Unknown]: null,
});

export function shikiIdForLanguage(lang: CodeLanguage): string | null {
	return SHIKI_LANGUAGE_ID[lang] ?? null;
}

function baseNameOf(path: string): string {
	const normalized = path.replace(/\\/g, "/");
	const lastSlash = normalized.lastIndexOf("/");
	return lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);
}

function extensionOf(path: string): string {
	const base = baseNameOf(path);
	const dot = base.lastIndexOf(".");
	// A leading-dot dotfile (".gitignore") has no extension.
	if (dot <= 0) return "";
	return base.slice(dot + 1).toLowerCase();
}

/** Special filename wins, then extension. `Unknown` if neither matches. */
export function languageForExtension(path: string): CodeLanguage {
	const basename = baseNameOf(path);
	if (basename && SPECIAL_FILENAMES[basename] !== undefined) {
		return SPECIAL_FILENAMES[basename] ?? CodeLanguage.Unknown;
	}
	const ext = extensionOf(path);
	if (!ext) return CodeLanguage.Unknown;
	return EXTENSION_MAP[ext] ?? CodeLanguage.Unknown;
}

export function languageForMime(mime: string): CodeLanguage {
	const normalized = mime.toLowerCase().split(";")[0]?.trim() ?? "";
	return MIME_MAP[normalized] ?? CodeLanguage.Unknown;
}

export function languageForShebang(firstLine: string): CodeLanguage {
	const m = /^#!\s*(?:\/usr\/bin\/env\s+)?(\S+)/.exec(firstLine);
	if (!m) return CodeLanguage.Unknown;
	const rawInterpreter = (m[1] ?? "").toLowerCase();
	// Strip path prefix: `/bin/bash` -> `bash`. An `env`-resolved
	// interpreter is already path-less and passes through unchanged.
	const lastSlash = rawInterpreter.lastIndexOf("/");
	const interpreter = lastSlash === -1 ? rawInterpreter : rawInterpreter.slice(lastSlash + 1);
	if (/^(?:python\d?(?:\.\d+)?)$/.test(interpreter)) return CodeLanguage.Python;
	if (/^(?:node|nodejs)$/.test(interpreter)) return CodeLanguage.JavaScript;
	if (interpreter === "deno" || interpreter === "bun") return CodeLanguage.TypeScript;
	if (/^(?:bash|zsh|fish|sh|dash|ksh)$/.test(interpreter)) return CodeLanguage.Shell;
	return CodeLanguage.Unknown;
}

/**
 * Best-guess language. Special filename / extension wins, then MIME, then
 * a `#!` shebang on the first line. When every signal is empty or
 * unrecognised, returns `options.fallback` (default `Unknown` — the Code
 * Editor wants "I can't prove a language"; the read-only Preview passes
 * `PlainText` so it still shows the file in a monospace gutter).
 */
export function detectLanguage(
	input: { path?: string; mime?: string; firstLine?: string },
	options?: { fallback?: CodeLanguage },
): CodeLanguage {
	const fallback = options?.fallback ?? CodeLanguage.Unknown;
	if (input.path) {
		const fromExt = languageForExtension(input.path);
		if (fromExt !== CodeLanguage.Unknown) return fromExt;
	}
	if (input.mime) {
		const fromMime = languageForMime(input.mime);
		if (fromMime !== CodeLanguage.Unknown) return fromMime;
	}
	if (input.firstLine) {
		const fromShebang = languageForShebang(input.firstLine);
		if (fromShebang !== CodeLanguage.Unknown) return fromShebang;
	}
	return fallback;
}
