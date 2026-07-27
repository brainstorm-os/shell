/**
 * Native `<select>` ban — zero baseline.
 *
 * Enumerated choices render through `@brainstorm-os/sdk/select-menu`
 * (`<SelectMenu>` React / `createSelectMenu` DOM / `openSelectMenu` imperative):
 * a `.bs-select` trigger opening its options as a fancy menu, with a check on
 * the chosen option and `group` for the `<optgroup>` case. A native `<select>`
 * drifts from the shared keyboard model, anchoring, theming and a11y, and — the
 * part that actually bites — renders as an OS widget that ignores the theme, so
 * it looks correct in exactly the one theme its author eyeballed.
 *
 * The tree is CLEAN today (verified 2026-07-27; the session-361 property-editing
 * audit found the same). This gate keeps it that way. `<select>` is the obvious
 * thing to reach for, so the risk is re-drift rather than a backlog — hence zero
 * baseline instead of a shrinking one.
 *
 * **Comments and string literals are stripped first, and that is the entire
 * reason this is a script and not a grep.** A naive `grep "<select"` over this
 * repo returns six hits, and all six are false positives: prose in doc comments
 * ("…not a native `<select>`") and CSS selector lists naming the element
 * (`input`/`textarea`/`select` focus resets). A gate that is wrong six times out
 * of six gets ignored and then deleted, so it has to read code, not text.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SOURCE_EXTENSIONS = [".ts", ".tsx"];

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
		else if (SOURCE_EXTENSIONS.some((ext) => full.endsWith(ext))) out.push(full);
	}
	return out;
}

/**
 * Blank out comments and string/template literals, preserving length and
 * newlines so reported line numbers still point at the real source line.
 */
export function stripCommentsAndStrings(src) {
	const out = src.split("");
	const blank = (from, to) => {
		for (let k = from; k < to && k < out.length; k++) {
			if (out[k] !== "\n") out[k] = " ";
		}
	};
	let i = 0;
	while (i < src.length) {
		const two = src.slice(i, i + 2);
		if (two === "//") {
			const end = src.indexOf("\n", i);
			const stop = end === -1 ? src.length : end;
			blank(i, stop);
			i = stop;
			continue;
		}
		if (two === "/*") {
			const end = src.indexOf("*/", i + 2);
			const stop = end === -1 ? src.length : end + 2;
			blank(i, stop);
			i = stop;
			continue;
		}
		const ch = src[i];
		if (ch === '"' || ch === "'" || ch === "`") {
			let j = i + 1;
			while (j < src.length) {
				if (src[j] === "\\") {
					j += 2;
					continue;
				}
				if (src[j] === ch) break;
				j++;
			}
			blank(i, Math.min(j + 1, src.length));
			i = j + 1;
			continue;
		}
		i++;
	}
	return out.join("");
}

/**
 * Native `<select>` elements in already-stripped code.
 *
 * The lookahead matters: `<select` must be followed by whitespace, `>` or `/`,
 * so a component named `<SelectMenu>` (the sanctioned replacement!) and an
 * element like `<selectable>` never match.
 */
export function findNativeSelectElements(strippedSource) {
	return [...strippedSource.matchAll(/<select(?=[\s/>])/g)].map((m) => ({
		index: m.index,
		kind: "jsx",
	}));
}

/**
 * The imperative twin, matched against RAW source: its tag name lives in a
 * string literal, which the stripper deliberately blanks.
 */
export function findCreateElementSelect(rawSource) {
	return [...rawSource.matchAll(/createElement\(\s*["'`]select["'`]/g)].map((m) => ({
		index: m.index,
		kind: "createElement",
	}));
}

/** Every offending usage in one file. */
export function findOffendingUsages(rawSource) {
	return [
		...findNativeSelectElements(stripCommentsAndStrings(rawSource)),
		...findCreateElementSelect(rawSource),
	].sort((a, b) => a.index - b.index);
}

const lineOf = (src, index) => src.slice(0, index).split("\n").length;

function main() {
	const roots = [
		...readdirSync("apps").map((app) => join("apps", app, "src")),
		...readdirSync("packages").map((pkg) => join("packages", pkg, "src")),
	];
	const files = roots.flatMap((root) => walk(root));
	const offenders = [];

	for (const file of files) {
		const raw = readFileSync(file, "utf8");
		if (!raw.includes("select")) continue; // cheap pre-filter
		for (const hit of findOffendingUsages(raw)) {
			offenders.push(`${file}:${lineOf(raw, hit.index)} — native <select> (${hit.kind})`);
		}
	}

	if (offenders.length > 0) {
		console.error(
			"✗ native-select: enumerated choices must render through @brainstorm-os/sdk/select-menu\n" +
				"  (<SelectMenu> React · createSelectMenu DOM · openSelectMenu imperative).\n" +
				"  A native <select> is an OS widget that ignores the theme and the shared keyboard model.\n",
		);
		for (const o of offenders) console.error(`    ${o}`);
		process.exit(1);
	}
	console.log(`✓ native-select: no native <select> across ${files.length} source files.`);
}

if (process.argv[1]?.endsWith("check-native-select.mjs")) main();
