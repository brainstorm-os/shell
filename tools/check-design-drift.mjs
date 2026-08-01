#!/usr/bin/env node
/**
 * Design-drift ratchet — hardcoded COLORS and FONT SIZES in app CSS.
 *
 * The two biggest sources of "this app looks off / breaks in the other
 * theme" that no existing gate catches:
 *
 *   - a literal color (`#hex`, `rgb()/rgba()`, `hsl()/hsla()`) bakes ONE
 *     theme's assumption into the surface — the exact drift that shipped the
 *     comments panel unreadable-on-dark. Colors come from theme tokens
 *     (`var(--color-…)` / the app-theme aliases), or from `color-mix()` OVER
 *     a token when a tint is genuinely derived.
 *   - a literal `font-size: NNpx` invents a type scale per app (Chat alone
 *     had 21) instead of riding `--text-size-*`, so type rhythm drifts app
 *     by app and a token-level scale change never reaches the surface.
 *
 * Grep-grade gate with a shrinking per-file baseline, same shape as
 * `check-app-reactivity.mjs` / `check-control-faces.mjs`:
 *   - a NON-baselined file gaining an offender fails (the ratchet: new code
 *     uses tokens), and a file exceeding its baselined COUNT fails;
 *   - a file dropping below its baselined count fails until the baseline is
 *     lowered (so the list only shrinks — run with --update after a drain).
 *
 * Deliberate literals — theme-independent DATA rather than chrome (the
 * whiteboard pen palette, a photo scrim that must be black in both themes) —
 * carry a `/* design-ok: <reason> *​/` marker on the same line and are not
 * counted. The marker is an audited exemption, not an escape hatch: the
 * per-app POLISH-APP drain reviews each one.
 *
 * Scope: apps/*​/src/**​/*.css. The SDK/shell/editor CSS is intentionally
 * excluded for now — the per-app program (POLISH-APP-*) drains apps first;
 * widen the roots when the app baselines hit zero.
 *
 * Run by `bun run lint` / `verify`. Regenerate after a drain with:
 *   node tools/check-design-drift.mjs --update
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APPS_DIR = join(ROOT, "apps");
const BASELINE_PATH = join(ROOT, "tools", "design-drift-baseline.json");

const DESIGN_OK = /design-ok:/;

/** Color literals. `transparent` / `currentColor` / `inherit` are values,
 *  not literals; `color-mix()` is checked by its ARGUMENTS (a mix over
 *  tokens is sanctioned derivation, a mix over literals is still a literal). */
const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g;

/** Literal px font sizes. Token references (`var(--text-size-…)`), `em`,
 *  `%`, `inherit` are all fine — only an invented px size drifts. */
const FONT_PX_RE = /font-size\s*:\s*[0-9.]+px/g;

function* cssFiles(dir) {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
		const full = join(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) yield* cssFiles(full);
		else if (name.endsWith(".css")) yield full;
	}
}

/** Count offending lines in one file: a line with a color/font-px literal
 *  and no design-ok marker. Block comments are stripped first so prose
 *  mentioning `#fff` never counts — but the design-ok marker is honored
 *  BEFORE stripping since it lives in a comment on the offending line. */
function countOffenders(src) {
	const lines = src.split("\n");
	let colors = 0;
	let fontPx = 0;
	let inBlockComment = false;
	for (const rawLine of lines) {
		let line = rawLine;
		if (inBlockComment) {
			const end = line.indexOf("*/");
			if (end === -1) continue;
			line = line.slice(end + 2);
			inBlockComment = false;
		}
		if (DESIGN_OK.test(rawLine)) continue;
		// Strip any block comments fully contained on the line, then detect
		// a comment that opens and does not close.
		line = line.replace(/\/\*[\s\S]*?\*\//g, "");
		const open = line.indexOf("/*");
		if (open !== -1) {
			line = line.slice(0, open);
			inBlockComment = true;
		}
		const colorHits = line.match(COLOR_RE);
		if (colorHits) colors += colorHits.length;
		const fontHits = line.match(FONT_PX_RE);
		if (fontHits) fontPx += fontHits.length;
	}
	return { colors, fontPx };
}

function scan() {
	/** @type {Record<string, {colors: number, fontPx: number}>} */
	const found = {};
	for (const appName of readdirSync(APPS_DIR)) {
		const appDir = join(APPS_DIR, appName, "src");
		let st;
		try {
			st = statSync(appDir);
		} catch {
			continue;
		}
		if (!st.isDirectory()) continue;
		for (const file of cssFiles(appDir)) {
			const { colors, fontPx } = countOffenders(readFileSync(file, "utf8"));
			if (colors > 0 || fontPx > 0) {
				// Baseline keys are posix-style so the file is identical across
				// platforms (Windows `relative()` yields backslashes).
				found[relative(ROOT, file).split(sep).join("/")] = { colors, fontPx };
			}
		}
	}
	return found;
}

const found = scan();

const DOC =
	"Per-file counts of literal colors + px font-sizes in app CSS, shrink-only. Drained by the POLISH-APP-* rungs; regenerate with `node tools/check-design-drift.mjs --update`.";

if (process.argv.includes("--update")) {
	const sorted = Object.fromEntries([
		["_doc", DOC],
		...Object.entries(found).sort(([a], [b]) => a.localeCompare(b)),
	]);
	writeFileSync(BASELINE_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
	console.log(`design-drift: baseline updated (${Object.keys(found).length} files).`);
	process.exit(0);
}

/** @type {Record<string, {colors: number, fontPx: number}>} */
const baseline = Object.fromEntries(
	Object.entries(JSON.parse(readFileSync(BASELINE_PATH, "utf8"))).filter(([k]) => k !== "_doc"),
);

const errors = [];
for (const [file, counts] of Object.entries(found)) {
	const base = baseline[file];
	if (!base) {
		errors.push(
			`${file}: ${counts.colors} literal color(s) + ${counts.fontPx} px font-size(s) in a file with a clean baseline — use theme tokens (or annotate deliberate data-literals with \`design-ok: <reason>\`).`,
		);
		continue;
	}
	if (counts.colors > base.colors || counts.fontPx > base.fontPx) {
		errors.push(
			`${file}: drift grew (colors ${base.colors}→${counts.colors}, font-px ${base.fontPx}→${counts.fontPx}) — new CSS must use tokens.`,
		);
	}
}
for (const [file, base] of Object.entries(baseline)) {
	const now = found[file];
	if (!now) {
		errors.push(
			`${file}: baselined drift is gone (was ${base.colors}+${base.fontPx}) — run \`node tools/check-design-drift.mjs --update\` so the baseline shrinks.`,
		);
	} else if (now.colors < base.colors || now.fontPx < base.fontPx) {
		errors.push(
			`${file}: drift shrank (colors ${base.colors}→${now.colors}, font-px ${base.fontPx}→${now.fontPx}) — run \`node tools/check-design-drift.mjs --update\` to lock it in.`,
		);
	}
}

if (errors.length > 0) {
	console.error("✗ design-drift ratchet:");
	for (const e of errors) console.error(`  ${e}`);
	process.exit(1);
}

const files = Object.keys(found).length;
const totals = Object.values(found).reduce(
	(acc, c) => ({ colors: acc.colors + c.colors, fontPx: acc.fontPx + c.fontPx }),
	{ colors: 0, fontPx: 0 },
);
console.log(
	`✓ design-drift: ${totals.colors} literal colors + ${totals.fontPx} px font-sizes across ${files} baselined files (shrink-only).`,
);
