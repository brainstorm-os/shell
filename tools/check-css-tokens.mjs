#!/usr/bin/env bun
/**
 * CSS-token existence ratchet.
 *
 * The rule (CLAUDE.md → "No phantom tokens"): app-side CSS may only
 * reference custom properties that actually exist at runtime — a real
 * theme token (packages/tokens, flattened to `--color-…`/`--space-…`
 * etc.), an app-theme alias (`--text`, `--bg-elev`, …), or a var the
 * code itself defines (CSS declaration or JS `setProperty`). A made-up
 * name "works" in whatever theme the author eyeballed because its
 * `var(--nope, fallback)` fallback renders, then breaks silently on
 * every other theme — that's how the comments panel shipped unreadable
 * on dark (phantom `--color-text-subtle` & co).
 *
 * Biome can't see across files, so this is a grep-grade gate with a
 * shrinking baseline (same pattern as check-app-reactivity.mjs).
 * Defined-name sources:
 *   1. `flattenTokens(theme)` keys for every theme in packages/tokens —
 *      imported from the real source so the list can never drift.
 *   2. Every `--x:` declaration in the scanned CSS (aliases in
 *      app-theme.css, component-local vars).
 *   3. Every `--x` string literal in TS/TSX under apps/ + the runtime
 *      packages (vars injected via setProperty / inline style objects /
 *      cssText) — generous on purpose: a missed definition must never
 *      produce a false alarm.
 *
 * The gate fails when (a) a non-baselined reference names an unknown
 * var — new code must use real tokens (add the token to EVERY theme in
 * packages/tokens first if the design genuinely needs a new one), or
 * (b) a baselined name is no longer referenced in that file — remove it
 * from tools/css-token-baseline.json so the list only shrinks.
 *
 * Run by `bun run lint` (needs bun — it imports the tokens TS directly).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { flattenTokens, themes } from "../packages/tokens/src/index.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = join(ROOT, "tools", "css-token-baseline.json");

/** CSS surfaces where a phantom token silently falls back. Includes the shell
 *  renderer: a phantom there (e.g. `--font-mono` for `--text-family-code`, or a
 *  no-fallback `--color-surface-2`) renders the wrong font / no background just
 *  as silently as in an app window. */
const CSS_SCOPES = [
	"apps",
	"packages/sdk/src",
	"packages/editor/src",
	"packages/shell/src/renderer",
];

/** Where runtime-injected var names can originate (setProperty, inline
 *  style objects, cssText template literals). */
const TS_SCOPES = [
	"apps",
	"packages/sdk/src",
	"packages/editor/src",
	"packages/shell/src",
	"packages/react-yjs/src",
];

const SKIP_DIRS = new Set(["node_modules", "dist", "out", "coverage", ".git"]);

function walkFiles(dir, exts, out = []) {
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (SKIP_DIRS.has(entry)) continue;
		const full = join(dir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) walkFiles(full, exts, out);
		else if (exts.some((ext) => entry.endsWith(ext))) out.push(full);
	}
	return out;
}

function stripCssComments(src) {
	return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

// ── 1. Theme tokens (the canonical set, straight from the source) ─────
const defined = new Set();
for (const tokens of Object.values(themes)) {
	for (const name of Object.keys(flattenTokens(tokens))) defined.add(name);
}

// ── 2 + 3. Declared in CSS / mentioned in TS ──────────────────────────
const cssFiles = CSS_SCOPES.flatMap((scope) => walkFiles(join(ROOT, scope), [".css"]));
for (const file of cssFiles) {
	const src = stripCssComments(readFileSync(file, "utf8"));
	for (const m of src.matchAll(/(?:^|[{;\s])(--[a-zA-Z0-9_-]+)\s*:/g)) defined.add(m[1]);
}
const tsFiles = TS_SCOPES.flatMap((scope) => walkFiles(join(ROOT, scope), [".ts", ".tsx"]));
for (const file of tsFiles) {
	// Test files carry token-name strings as fixtures/expectations, not as
	// runtime definitions — counting them would let a fixture mask a real
	// phantom (e.g. codec.test.ts's "--color-accent").
	if (/\.test\.tsx?$/.test(file)) continue;
	const src = readFileSync(file, "utf8");
	// Only count genuine DEFINITIONS, not `var(--x)` references. A .tsx that
	// embeds CSS in a template literal (e.g. inline-property-form.tsx) would
	// otherwise have its phantom `var(--nope)` references counted as defs and
	// whitelist them project-wide — masking real phantoms (the exact gap that
	// let agent/browser/automations phantoms slip past this gate).
	// Definitions are QUOTED string literals ("--x" in setProperty / inline
	// style objects / computed keys / cssText) or CSS declarations (`--x:`
	// at the start of a rule inside a template literal). `var(--x)` references
	// are UNQUOTED and sit after `(`, so neither pattern matches them — which
	// is exactly the distinction that was missing.
	for (const m of src.matchAll(/["'`](--[a-zA-Z0-9_-]+)["'`]/g)) defined.add(m[1]);
	for (const m of src.matchAll(/(?:^|[{;\n])\s*(--[a-zA-Z0-9_-]+)\s*:/g)) defined.add(m[1]);
}

// ── Scan references ────────────────────────────────────────────────────
/** file (repo-relative) → Set of unknown var names referenced there. */
const violations = new Map();
for (const file of cssFiles) {
	const src = stripCssComments(readFileSync(file, "utf8"));
	for (const m of src.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)) {
		const name = m[1];
		if (defined.has(name)) continue;
		const rel = relative(ROOT, file);
		if (!violations.has(rel)) violations.set(rel, new Map());
		if (!violations.get(rel).has(name)) {
			const line = src.slice(0, m.index).split("\n").length;
			violations.get(rel).set(name, line);
		}
	}
}

// ── Ratchet against the baseline ───────────────────────────────────────
let baseline = {};
try {
	baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
} catch {
	// No baseline yet → everything found is new.
}

const fresh = [];
for (const [file, names] of violations) {
	const grandfathered = new Set(baseline[file] ?? []);
	for (const [name, line] of names) {
		if (!grandfathered.has(name)) fresh.push(`${file}:${line} references unknown token ${name}`);
	}
}

const stale = [];
for (const [file, names] of Object.entries(baseline)) {
	const current = violations.get(file);
	for (const name of names) {
		if (!current?.has(name)) stale.push(`${file} no longer references ${name}`);
	}
}

if (fresh.length > 0) {
	console.error("✗ CSS references tokens that do not exist in any theme / definition:\n");
	for (const line of fresh) console.error(`  ${line}`);
	console.error(
		"\nUse a real token (packages/tokens) or an app-theme alias (packages/sdk/src/app-theme.css)." +
			"\nIf the design needs a NEW token, add it to EVERY theme in packages/tokens/src/themes.ts first.",
	);
}
if (stale.length > 0) {
	console.error("✗ css-token-baseline.json is stale (the ratchet only shrinks):\n");
	for (const line of stale) console.error(`  ${line}`);
	console.error(`\nRemove the fixed entries from ${relative(ROOT, BASELINE_PATH)}.`);
}

if (fresh.length > 0 || stale.length > 0) process.exit(1);
const grandTotal = [...violations.values()].reduce((n, m) => n + m.size, 0);
console.log(
	grandTotal === 0
		? "✓ css tokens: every var() reference resolves"
		: `✓ css tokens: no new phantom tokens (${grandTotal} grandfathered in the baseline)`,
);
