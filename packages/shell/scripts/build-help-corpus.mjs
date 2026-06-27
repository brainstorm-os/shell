#!/usr/bin/env node
/**
 * Help-1 — build the in-shell Help corpus from the curated source declared
 * in. Mirrors `scripts/build-icons.mjs`'s
 * pattern: read source files at build time and emit a single bundled
 * artifact the main process imports via Vite's static JSON inliner.
 *
 * Source location: `packages/shell/help-content/` — purpose-written user-
 * facing articles. The engineering docs under `docs/` stay as the org-repo
 * source of truth and are no longer reached by the Help build (rewritten
 * 2026-05-25 — see implementation-log.md / Help-1 content rewrite).
 *
 * Output: `packages/shell/help-corpus/corpus.json` with the
 * `brainstorm/help-corpus/v1` format consumed by `main/help/help-corpus.ts`.
 *
 * Hard fences (release-blocking — `bun run verify` exercises this script
 * indirectly via the prebuild hook):
 *   - the manifest format must be `brainstorm/help-manifest/v1`
 *   - every referenced `.md` file must exist
 *   - no relative-path escape (`..`) is allowed in manifest entries
 *   - duplicate `topicId` across the corpus is rejected (resolver invariant —
 *     `resolveTopicId(route) → topicId` must be one-to-one)
 *
 * Frontmatter (`---\n…\n---`) is stripped. Plaintext is derived from the
 * Markdown by collapsing fence-language hints, links to their label text,
 * and emphasis markers — enough for the FTS5 indexer to tokenise on words.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// `new URL(...).pathname` yields a leading-slash drive form on Windows
// (`/D:/…`) that `path.join` then mangles into a doubled drive (`D:\D:\…`);
// `fileURLToPath` decodes to the correct native path on every platform.
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const CONTENT_DIR = join(ROOT, "packages/shell/help-content");
// The Help corpus is built entirely from sources VENDORED into the shell repo
// (`help-content/`), so a public/standalone shell checkout — and CI — builds
// without the harness repo present. The manifest lives alongside that content;
// the `docs/`-rooted candidates are legacy fallbacks for a harness-based build
// (the engineering `docs/` are the harness repo's, not the shell's).
const MANIFEST_CANDIDATES = [
	join(CONTENT_DIR, "help-manifest.json"),
	join(ROOT, "docs/help-manifest.json"),
	join(ROOT, "../harness/docs/help-manifest.json"),
	join(ROOT, "../docs/help-manifest.json"),
];
const MANIFEST_PATH = MANIFEST_CANDIDATES.find((p) => existsSync(p)) ?? MANIFEST_CANDIDATES[0];
const OUT_PATH = join(ROOT, "packages/shell/help-corpus/corpus.json");

const TopicKind = {
	GettingStarted: "getting-started",
	Guide: "guide",
	App: "app",
};
const TOPIC_KINDS = new Set(Object.values(TopicKind));

const SECTION_TITLE_FALLBACKS = {
	"shell.help.section.gettingStarted": "Getting started",
	"shell.help.section.concepts": "Concepts",
	"shell.help.section.app.notes": "Notes",
	"shell.help.section.app.tasks": "Tasks",
	"shell.help.section.app.files": "Files",
	"shell.help.section.app.calendar": "Calendar",
	"shell.help.section.app.journal": "Journal",
	"shell.help.section.app.database": "Database",
	"shell.help.section.app.graph": "Graph",
	"shell.help.section.app.whiteboard": "Whiteboard",
	"shell.help.section.app.bookmarks": "Bookmarks",
	"shell.help.section.app.codeEditor": "Code Editor",
	"shell.help.section.customising": "Customising",
	"shell.help.section.privacy": "Privacy",
};

function main() {
	const raw = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
	if (raw?.format !== "brainstorm/help-manifest/v1") {
		throw new Error(`build-help-corpus: unsupported manifest format ${JSON.stringify(raw?.format)}`);
	}
	if (!Array.isArray(raw.sections) || raw.sections.length === 0) {
		throw new Error("build-help-corpus: manifest sections must be a non-empty array");
	}

	const articles = [];
	const topicIds = new Set();
	const sections = [];

	for (const section of raw.sections) {
		assertSection(section);
		sections.push({
			id: section.id,
			titleKey: section.titleKey,
			title: SECTION_TITLE_FALLBACKS[section.titleKey] ?? section.id,
			kind: section.kind,
			...(section.appId ? { appId: section.appId } : {}),
		});
		for (const relPath of section.files) {
			assertNoTraversal(relPath);
			const absPath = join(CONTENT_DIR, relPath);
			let source;
			try {
				source = readFileSync(absPath, "utf8");
			} catch (error) {
				throw new Error(
					`build-help-corpus: missing content file ${relPath} referenced by section ${section.id}: ${error.message}`,
				);
			}
			const stripped = stripFrontmatter(source);
			const rawTitle = extractTitle(stripped, relPath);
			const title = stripDocNumbering(rawTitle);
			const body = stripLeadingHeading(stripped);
			const slug = slugFor(relPath);
			const topicId = topicIdFor(section, slug);
			if (topicIds.has(topicId)) {
				throw new Error(`build-help-corpus: duplicate topicId ${topicId} (section ${section.id})`);
			}
			topicIds.add(topicId);
			const headings = extractHeadings(body);
			const plaintext = toPlaintext(body);
			articles.push({
				topicId,
				sectionId: section.id,
				title,
				slug,
				markdown: body,
				plaintext,
				headings,
				relPath,
			});
		}
	}

	const corpus = {
		format: "brainstorm/help-corpus/v1",
		sections,
		articles,
	};
	mkdirSync(dirname(OUT_PATH), { recursive: true });
	writeFileSync(OUT_PATH, `${JSON.stringify(corpus, null, "\t")}\n`, "utf8");
	console.log(
		`build-help-corpus: wrote ${articles.length} article(s) across ${raw.sections.length} section(s) → ${OUT_PATH}`,
	);
}

function assertSection(section) {
	if (!section || typeof section !== "object") {
		throw new Error("build-help-corpus: section must be an object");
	}
	if (typeof section.id !== "string" || section.id.length === 0) {
		throw new Error("build-help-corpus: section.id must be a non-empty string");
	}
	if (typeof section.titleKey !== "string" || section.titleKey.length === 0) {
		throw new Error(`build-help-corpus: section ${section.id} titleKey must be a non-empty string`);
	}
	if (!TOPIC_KINDS.has(section.kind)) {
		throw new Error(
			`build-help-corpus: section ${section.id} kind ${JSON.stringify(section.kind)} must be one of ${[...TOPIC_KINDS].join(", ")}`,
		);
	}
	if (section.kind === TopicKind.App) {
		if (typeof section.appId !== "string" || section.appId.length === 0) {
			throw new Error(`build-help-corpus: section ${section.id} (app) requires appId`);
		}
	}
	if (!Array.isArray(section.files) || section.files.length === 0) {
		throw new Error(`build-help-corpus: section ${section.id} files must be a non-empty array`);
	}
}

function assertNoTraversal(relPath) {
	if (relPath.includes("..")) {
		throw new Error(`build-help-corpus: rejected path with traversal ${relPath}`);
	}
}

function stripFrontmatter(source) {
	if (!source.startsWith("---\n")) return source;
	const end = source.indexOf("\n---\n", 4);
	if (end === -1) return source;
	return source.slice(end + 5);
}

function extractTitle(markdown, relPath) {
	const match = markdown.match(/^#\s+(.+?)\s*$/m);
	if (match) return match[1].replace(/[`*_]/g, "");
	return relPath.replace(/\.md$/, "");
}

function stripDocNumbering(title) {
	return title.replace(/^\d+[a-z]?\s*[—-]\s*/, "").trim();
}

function stripLeadingHeading(markdown) {
	const idx = markdown.indexOf("\n");
	const firstLine = idx === -1 ? markdown : markdown.slice(0, idx);
	if (!firstLine.match(/^#\s+/)) {
		const leadingBlank = markdown.match(/^(\s*\n)+/);
		return leadingBlank ? markdown.slice(leadingBlank[0].length) : markdown;
	}
	const remainder = idx === -1 ? "" : markdown.slice(idx + 1);
	const leadingBlank = remainder.match(/^(\s*\n)+/);
	return leadingBlank ? remainder.slice(leadingBlank[0].length) : remainder;
}

function slugFor(relPath) {
	return relPath.replace(/\.md$/, "").replace(/[^a-zA-Z0-9/-]/g, "-");
}

function topicIdFor(section, slug) {
	if (section.kind === TopicKind.App) {
		return `app/${section.appId}/${slug}`;
	}
	if (section.kind === TopicKind.GettingStarted) {
		return `guide/getting-started/${slug}`;
	}
	return `guide/${slug}`;
}

function extractHeadings(markdown) {
	const out = [];
	for (const line of markdown.split("\n")) {
		const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
		if (!m) continue;
		const depth = m[1].length;
		const text = m[2].replace(/[`*_]/g, "");
		const anchor = text
			.toLowerCase()
			.replace(/[^a-z0-9\s-]/g, "")
			.trim()
			.replace(/\s+/g, "-");
		out.push({ depth, text, anchor });
	}
	return out;
}

function toPlaintext(markdown) {
	return markdown
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, "$1")
		.replace(/^>\s?/gm, "")
		.replace(/\s+/g, " ")
		.trim();
}

main();
