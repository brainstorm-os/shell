#!/usr/bin/env node
/**
 * Control-face ratchet.
 *
 * The design-system invariant: a control's box (height / padding / border /
 * surface) comes from a SHARED primitive, never from hand-rolled per-app CSS.
 * Buttons ride `.bs-btn`, selects ride `.bs-select`, and text fields ride
 * `.bs-input` — all on the same `--control-height-*` scale, so a control lines
 * up pixel-exact beside any other of the same size. When an app drops a raw
 * `<input>` / `<textarea>` / `<select>` and styles it itself, its height drifts
 * from the select/button next to it (the Calendar New-event date-vs-time
 * mismatch). The design system can only PREVENT that if it's enforced, not
 * merely documented — that's this gate.
 *
 * Biome 1.9 can't express a custom "this element must carry that class" rule,
 * so this is a grep-grade gate with a shrinking baseline (same shape as
 * `check-app-reactivity.mjs`). A native text-like form control must carry a
 * recognized face class (`bs-input`, or `bs-select` for a select). Every app
 * file that currently has a non-compliant control is grandfathered in
 * `control-faces-baseline.json`. The gate fails when:
 *   - a NON-baselined app file gains a non-compliant control (the ratchet:
 *     new code and new apps must compose from the primitive), or
 *   - a baselined file no longer has one (migrated — drop it from the baseline
 *     so the list can only shrink).
 *
 * Run by `bun run lint` and `bun run verify`.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APPS_DIR = join(ROOT, "apps");
const BASELINE_PATH = join(ROOT, "tools", "control-faces-baseline.json");

/** `<input type=...>` kinds that are NOT field-faces — they get their own
 *  bespoke chrome (checkbox/radio/range/swatch) or are non-visual. */
const EXEMPT_INPUT_TYPES = new Set([
	"button",
	"submit",
	"reset",
	"checkbox",
	"radio",
	"range",
	"file",
	"color",
	"hidden",
	"image",
]);

const FACE_TOKENS = ["bs-input", "bs-input__control", "bs-select"];

function stripComments(src) {
	return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** A non-compliant control is a text-like native form element whose opening
 *  tag does not reference a shared face class. Arrow functions (`=>`) are
 *  neutralized first so their `>` doesn't prematurely close a tag match. */
function hasHandRolledControl(src) {
	const code = stripComments(src).replace(/=>/g, "= ");
	const tagRe = /<(input|textarea|select)\b([\s\S]*?)>/g;
	for (let m = tagRe.exec(code); m !== null; m = tagRe.exec(code)) {
		const [, el, attrs] = m;
		if (el === "input") {
			const typeMatch = /type=["']([a-z-]+)["']/.exec(attrs);
			const type = typeMatch ? typeMatch[1] : "text";
			if (EXEMPT_INPUT_TYPES.has(type)) continue;
		}
		if (!FACE_TOKENS.some((tok) => attrs.includes(tok))) return true;
	}
	return false;
}

function* walk(dir) {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === "dist") continue;
		const full = join(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) {
			yield* walk(full);
		} else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
			yield full;
		}
	}
}

const toPosix = (p) => relative(ROOT, p).split("\\").join("/");

const offenders = [];
for (const file of walk(APPS_DIR)) {
	if (hasHandRolledControl(readFileSync(file, "utf8"))) offenders.push(toPosix(file));
}
offenders.sort();

const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")).files;
const baselineSet = new Set(baseline);
const offenderSet = new Set(offenders);

const newViolations = offenders.filter((f) => !baselineSet.has(f));
const staleBaseline = baseline.filter((f) => !offenderSet.has(f));

if (newViolations.length === 0 && staleBaseline.length === 0) {
	console.log(`✓ control-faces: ${offenders.length} baselined hand-rolled control(s), no new ones.`);
	process.exit(0);
}

if (newViolations.length > 0) {
	console.error("\n✗ control-faces: native form control(s) not built on a shared face — give the");
	console.error("  <input>/<textarea>/<select> the `bs-input` class (or use <SelectMenu>):\n");
	for (const f of newViolations) console.error(`    ${f}`);
	console.error(
		"\n  (See docs/apps/09-shared-sdk-catalog.md → '.bs-input'. The box — height / border /\n   surface — comes from the primitive so it lines up with buttons/selects beside it.)",
	);
}

if (staleBaseline.length > 0) {
	console.error("\n✗ control-faces: baselined file(s) no longer hand-roll a control — migrated!");
	console.error(`  Remove them from ${toPosix(BASELINE_PATH)} so the ratchet stays tight:\n`);
	for (const f of staleBaseline) console.error(`    ${f}`);
}

console.error("");
process.exit(1);
