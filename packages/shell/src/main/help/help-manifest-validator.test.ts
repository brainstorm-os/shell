/**
 * Build-time fence — every file declared in
 * exists on disk under `packages/shell/help-content/`. The new user-
 * facing corpus lives outside `docs/` (rewritten 2026-05-25, see
 * implementation-log.md / Help-1 content rewrite); the prior
 * / `implementation-plan*` / threat-model exclusion fences became
 * irrelevant once the source moved out of the org-repo docs tree.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..", "..", "..");
const CONTENT_DIR = join(ROOT, "packages", "shell", "help-content");
// The manifest is vendored alongside the help content (so a standalone shell
// checkout / CI builds without the harness `docs/`); fall back to the legacy
// `docs/` location for a harness-based checkout.
const MANIFEST_PATH = [
	join(CONTENT_DIR, "help-manifest.json"),
	join(ROOT, "docs", "help-manifest.json"),
].find((p) => existsSync(p)) as string;

type ManifestSection = {
	id: string;
	titleKey: string;
	kind: "guide" | "getting-started" | "app";
	appId?: string;
	files: string[];
};

type Manifest = {
	format: string;
	sections: ManifestSection[];
};

const MANIFEST = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;

describe("docs/help-manifest.json", () => {
	it("uses the brainstorm/help-manifest/v1 format", () => {
		expect(MANIFEST.format).toBe("brainstorm/help-manifest/v1");
	});

	it("declares at least one section with at least one file", () => {
		expect(MANIFEST.sections.length).toBeGreaterThan(0);
		for (const section of MANIFEST.sections) {
			expect(section.files.length).toBeGreaterThan(0);
		}
	});

	it("every referenced file exists on disk under packages/shell/help-content/", () => {
		for (const section of MANIFEST.sections) {
			for (const relPath of section.files) {
				const absPath = join(CONTENT_DIR, relPath);
				expect(existsSync(absPath), `missing file ${relPath} in section ${section.id}`).toBe(true);
			}
		}
	});

	it("no manifest path contains `..` traversal", () => {
		for (const section of MANIFEST.sections) {
			for (const relPath of section.files) {
				expect(relPath.includes(".."), `${relPath} contains traversal`).toBe(false);
			}
		}
	});

	it("every `app`-kind section declares an appId", () => {
		for (const section of MANIFEST.sections) {
			if (section.kind === "app") {
				expect(section.appId, `section ${section.id} kind=app missing appId`).toBeTruthy();
			}
		}
	});

	it("section ids are unique", () => {
		const ids = MANIFEST.sections.map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
