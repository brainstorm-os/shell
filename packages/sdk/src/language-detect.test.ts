import { describe, expect, it } from "vitest";
import {
	CodeLanguage,
	detectLanguage,
	isCodeLanguage,
	languageDisplayLabel,
	languageForExtension,
	languageForMime,
	languageForShebang,
	shikiIdForLanguage,
} from "./language-detect";

describe("languageForExtension", () => {
	it("recognises common source extensions, case-insensitively, ignoring the directory", () => {
		expect(languageForExtension("src/app.ts")).toBe(CodeLanguage.TypeScript);
		expect(languageForExtension("/a/b/Comp.TSX")).toBe(CodeLanguage.TSX);
		expect(languageForExtension("main.PY")).toBe(CodeLanguage.Python);
		expect(languageForExtension("deep\\win\\style.css")).toBe(CodeLanguage.CSS);
		expect(languageForExtension("a.mts")).toBe(CodeLanguage.TypeScript);
		expect(languageForExtension("a.cjs")).toBe(CodeLanguage.JavaScript);
		expect(languageForExtension("page.xml")).toBe(CodeLanguage.HTML);
		expect(languageForExtension("notes.txt")).toBe(CodeLanguage.PlainText);
	});

	it("prefers special filenames over their extension", () => {
		expect(languageForExtension("x/Dockerfile")).toBe(CodeLanguage.Dockerfile);
		expect(languageForExtension("tsconfig.json")).toBe(CodeLanguage.JSONC);
		expect(languageForExtension("Makefile")).toBe(CodeLanguage.Shell);
		expect(languageForExtension(".gitignore")).toBe(CodeLanguage.PlainText);
	});

	it("returns Unknown for unmapped / extensionless files", () => {
		expect(languageForExtension("foo.unknown-ext")).toBe(CodeLanguage.Unknown);
		expect(languageForExtension("README")).toBe(CodeLanguage.Unknown);
		expect(languageForExtension("")).toBe(CodeLanguage.Unknown);
	});
});

describe("languageForMime", () => {
	it("recognises core MIME types (union of both callers' maps)", () => {
		expect(languageForMime("text/x-typescript")).toBe(CodeLanguage.TypeScript);
		expect(languageForMime("application/json")).toBe(CodeLanguage.JSON);
		expect(languageForMime("text/markdown")).toBe(CodeLanguage.Markdown);
		expect(languageForMime("text/x-rust")).toBe(CodeLanguage.Rust);
		expect(languageForMime("text/x-rustsrc")).toBe(CodeLanguage.Rust);
		expect(languageForMime("application/xml")).toBe(CodeLanguage.HTML);
	});

	it("ignores parameters and is case-insensitive", () => {
		expect(languageForMime("application/json; charset=utf-8")).toBe(CodeLanguage.JSON);
		expect(languageForMime("APPLICATION/JSON")).toBe(CodeLanguage.JSON);
	});

	it("returns Unknown for unmapped MIME types", () => {
		expect(languageForMime("application/octet-stream")).toBe(CodeLanguage.Unknown);
		expect(languageForMime("")).toBe(CodeLanguage.Unknown);
	});
});

describe("languageForShebang", () => {
	it("recognises python / node / bash / deno / bun", () => {
		expect(languageForShebang("#!/usr/bin/env python3")).toBe(CodeLanguage.Python);
		expect(languageForShebang("#!/usr/bin/env node")).toBe(CodeLanguage.JavaScript);
		expect(languageForShebang("#!/bin/bash")).toBe(CodeLanguage.Shell);
		expect(languageForShebang("#!/usr/bin/env deno run")).toBe(CodeLanguage.TypeScript);
		expect(languageForShebang("#!/usr/bin/env bun")).toBe(CodeLanguage.TypeScript);
	});

	it("returns Unknown for non-shebang / unrecognised interpreters", () => {
		expect(languageForShebang("import { foo } from 'bar';")).toBe(CodeLanguage.Unknown);
		expect(languageForShebang("")).toBe(CodeLanguage.Unknown);
		expect(languageForShebang("#!/usr/bin/env tcl")).toBe(CodeLanguage.Unknown);
	});
});

describe("detectLanguage", () => {
	it("prefers extension over MIME over shebang", () => {
		expect(
			detectLanguage({ path: "foo.py", mime: "text/html", firstLine: "#!/usr/bin/env node" }),
		).toBe(CodeLanguage.Python);
	});

	it("falls back to MIME, then shebang", () => {
		expect(detectLanguage({ path: "foo.unknown-ext", mime: "application/json" })).toBe(
			CodeLanguage.JSON,
		);
		expect(detectLanguage({ path: "foo", firstLine: "#!/usr/bin/env python3" })).toBe(
			CodeLanguage.Python,
		);
	});

	it("returns Unknown by default when every signal is empty", () => {
		expect(detectLanguage({})).toBe(CodeLanguage.Unknown);
	});

	it("returns the supplied fallback when every signal is empty / unknown", () => {
		expect(detectLanguage({}, { fallback: CodeLanguage.PlainText })).toBe(CodeLanguage.PlainText);
		expect(
			detectLanguage(
				{ path: "data.bin", mime: "application/octet-stream" },
				{ fallback: CodeLanguage.PlainText },
			),
		).toBe(CodeLanguage.PlainText);
	});
});

describe("languageDisplayLabel + isCodeLanguage", () => {
	it("returns a non-empty label for every enum member", () => {
		for (const lang of Object.values(CodeLanguage)) {
			expect(languageDisplayLabel(lang).length).toBeGreaterThan(0);
		}
		expect(languageDisplayLabel(CodeLanguage.TypeScript)).toBe("TypeScript");
		expect(languageDisplayLabel(CodeLanguage.PlainText)).toBe("Plain text");
	});

	it("guards enum membership", () => {
		expect(isCodeLanguage("typescript")).toBe(true);
		expect(isCodeLanguage("nope")).toBe(false);
		expect(isCodeLanguage(42)).toBe(false);
	});
});

describe("shikiIdForLanguage", () => {
	it("maps every language to a grammar id, except the two deliberate nulls", () => {
		for (const lang of Object.values(CodeLanguage)) {
			const id = shikiIdForLanguage(lang);
			if (lang === CodeLanguage.PlainText || lang === CodeLanguage.Unknown) {
				expect(id).toBeNull();
			} else {
				expect(typeof id).toBe("string");
			}
		}
		// The two renames Shiki insists on.
		expect(shikiIdForLanguage(CodeLanguage.Shell)).toBe("shellscript");
		expect(shikiIdForLanguage(CodeLanguage.Dockerfile)).toBe("docker");
	});
});
