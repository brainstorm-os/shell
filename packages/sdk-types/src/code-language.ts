/**
 * The source-language identifiers every code surface agrees on — the Code
 * editor, Preview's code renderer, the Shiki highlighter dispatch, and the
 * agent's proposed-code-file payload.
 *
 * It lives in the contract leaf (not next to `detectLanguage` in
 * `@brainstorm-os/sdk/language-detect`, which re-exports it) because
 * `ProposedCodeFile` names it, and the propose contract must stay
 * dependency-free so the main process and the apps share one declaration.
 */

export enum CodeLanguage {
	TypeScript = "typescript",
	JavaScript = "javascript",
	TSX = "tsx",
	JSX = "jsx",
	JSON = "json",
	JSONC = "jsonc",
	HTML = "html",
	CSS = "css",
	Markdown = "markdown",
	Python = "python",
	Rust = "rust",
	Go = "go",
	Java = "java",
	Shell = "shell",
	YAML = "yaml",
	TOML = "toml",
	SQL = "sql",
	Dockerfile = "dockerfile",
	PlainText = "plaintext",
	Unknown = "unknown",
}
