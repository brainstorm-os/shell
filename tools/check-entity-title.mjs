/**
 * Private entity-title resolver ratchet (DS-entity-title-1).
 *
 * "What do we call this object?" is ONE chain, in
 * `@brainstorm-os/sdk/entity-title` (title → name → displayName → label →
 * path leaf). Every surface that paints an entity consumes it. A file that
 * walks its own chain — `props.title ?? props.name`, `str(p.name) ||
 * str(p.title)`, a private `TITLE_KEYS` loop — is how the fleet drifted:
 * Files read `name` only (so every Note and every CodeFile rendered
 * "(untitled)" in the vault browser) while Graph preferred `name` over
 * `title` (so an object carrying both was called one thing on the canvas
 * and another on its tile). Patching one app's copy in place is exactly
 * what let that divergence survive for three months.
 *
 * Heuristic: two or more DISTINCT title-shaped keys read off a
 * `properties` / `props` / `p` bag inside a 6-line window. Comments and
 * string literals are stripped first — the doc comments in these very
 * modules name the keys, and a `SKIP_KEYS = new Set(["title", "name"])`
 * (a legitimate render-exclusion list) is string data, not a chain.
 * Reading ONE key of a type you own — `Whiteboard/v1`'s required `name`,
 * a Bookmark's `title` — is not a chain and is not flagged.
 *
 * Zero baseline: any hit fails. Consume the SDK resolver instead — and if
 * your surface needs a different FALLBACK for a nameless object, that is
 * what `entityTitleOr`'s second argument is for.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** The shared chain's keys — mirrors `ENTITY_TITLE_KEYS`. */
export const TITLE_KEYS = ["title", "name", "displayName", "label"];

/** How many lines count as "one resolver" for the distinct-key tally. */
export const WINDOW_LINES = 6;

/** The module that IS the chain. */
const ALLOWED = new Set(["packages/sdk/src/entity-title.ts"]);

/**
 * Blank out block/line comments and string/template literals, preserving
 * line structure so reported line numbers stay true.
 */
export function stripCommentsAndStrings(src) {
	const blank = (text) => text.replace(/[^\n]/g, " ");
	let out = "";
	let i = 0;
	while (i < src.length) {
		const two = src.slice(i, i + 2);
		if (two === "/*") {
			const end = src.indexOf("*/", i + 2);
			const stop = end === -1 ? src.length : end + 2;
			out += blank(src.slice(i, stop));
			i = stop;
			continue;
		}
		if (two === "//") {
			const end = src.indexOf("\n", i);
			const stop = end === -1 ? src.length : end;
			out += blank(src.slice(i, stop));
			i = stop;
			continue;
		}
		const ch = src[i];
		if (ch === '"' || ch === "'" || ch === "`") {
			let j = i + 1;
			while (j < src.length && src[j] !== ch) j += src[j] === "\\" ? 2 : 1;
			out += ch + blank(src.slice(i + 1, j)) + (src[j] ?? "");
			i = j + 1;
			continue;
		}
		out += ch;
		i += 1;
	}
	return out;
}

const DOT_KEY = () =>
	new RegExp(String.raw`\b(?:properties|props|p)\s*\.\s*(${TITLE_KEYS.join("|")})\b`, "g");

/** Bracket access is matched against RAW source: its key lives in a string
 *  literal, which the stripper deliberately blanks. The `properties[`
 *  prefix is what keeps a bare `new Set(["title", "name"])` out of it. */
const BRACKET_KEY = () =>
	new RegExp(
		String.raw`\b(?:properties|props|p)\s*\[\s*["'\`](${TITLE_KEYS.join("|")})["'\`]\s*\]`,
		"g",
	);

const lineOf = (src, index) => src.slice(0, index).split("\n").length;

/**
 * Every private-chain hit in one file's raw source, as `{ line, keys }` —
 * one entry per group of title-key reads sitting within `WINDOW_LINES` of
 * each other, anchored at the first read's line.
 */
export function findPrivateResolvers(rawSource) {
	const reads = [
		...[...stripCommentsAndStrings(rawSource).matchAll(DOT_KEY())],
		...[...rawSource.matchAll(BRACKET_KEY())],
	]
		.map((match) => ({ line: lineOf(rawSource, match.index), key: match[1] }))
		.sort((a, b) => a.line - b.line);

	const hits = [];
	let group = [];
	const flush = () => {
		const keys = new Set(group.map((r) => r.key));
		if (keys.size >= 2) hits.push({ line: group[0].line, keys: [...keys].sort() });
		group = [];
	};
	for (const read of reads) {
		if (group.length > 0 && read.line - group[0].line >= WINDOW_LINES) flush();
		group.push(read);
	}
	if (group.length > 0) flush();
	return hits;
}

function walk(dir, out = []) {
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (entry === "node_modules" || entry === "dist") continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) walk(full, out);
		else if (/\.tsx?$/.test(full) && !full.includes(".test.")) out.push(full);
	}
	return out;
}

function main() {
	const roots = [
		...readdirSync("apps").map((app) => join("apps", app, "src")),
		"packages/sdk/src",
		"packages/shell/src",
		"packages/editor/src",
		"packages/react-yjs/src",
	];
	const files = roots.flatMap((root) => walk(root));
	const offenders = [];

	for (const file of files) {
		if (ALLOWED.has(file)) continue;
		for (const hit of findPrivateResolvers(readFileSync(file, "utf8"))) {
			offenders.push(`${file}:${hit.line} — reads ${hit.keys.join(" + ")}`);
		}
	}

	if (offenders.length > 0) {
		console.error(
			"✗ entity-title: private label resolver(s) — every surface resolves an object's name\n" +
				"  through @brainstorm-os/sdk/entity-title (resolveEntityTitle / entityTitleOr).\n" +
				"  A per-app chain drifts: Files read `name` only and painted every Note '(untitled)'.\n",
		);
		for (const o of offenders) console.error(`    ${o}`);
		process.exit(1);
	}
	console.log(`✓ entity-title: one shared chain across ${files.length} source files.`);
}

if (process.argv[1]?.endsWith("check-entity-title.mjs")) main();
