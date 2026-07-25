/**
 * Panel-toggle availability ratchet.
 *
 * The recurring bug: a right-hand panel (inspector / properties / members)
 * only renders when something is selected, but its header toggle stays
 * enabled — so clicking it does nothing and the button reads as broken.
 * Every app hits this the same way and each one was fixed by hand.
 *
 * Two mechanical rules, both zero-false-positive by construction:
 *
 *   1. Every `<PanelToggleButton side={PanelSide.Right} …>` declares its
 *      availability — it passes `disabled`, or its file is baselined as an
 *      always-live panel (one that renders its own empty state, or collapses
 *      via CSS, so the toggle is never a no-op). The point is not that
 *      `disabled` is always right; it is that the call site must have made
 *      the decision. Left-side toggles are exempt: a nav sidebar has content
 *      independent of the selection.
 *
 *   2. No app builds its own panel toggle. `panelToggleIcon` is the SDK
 *      button helper's private glyph — an app importing it directly is
 *      hand-rolling the chrome (that is how Database shipped header toggles
 *      with hardcoded English labels that never tracked open/closed).
 *      Use `createPanelToggleButton` / `<PanelToggleButton>`. Zero baseline.
 *
 * Not covered: a toggle built from scratch with its own glyph (Whiteboard's
 * layers button) is invisible to both rules — there is no grep-grade tell for
 * "this button opens a panel". Rule 2 shrinks that gap by making the shared
 * helper the only supported way to build one.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = join(ROOT, "tools", "panel-toggle-baseline.json");

/** Repo-relative with forward slashes — the baseline is checked in POSIX-style,
 *  and `relative()` yields backslashes on Windows CI. */
const toPosix = (p) => relative(ROOT, p).split("\\").join("/");

function walk(dir, exts, out = []) {
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (entry === "node_modules" || entry === "dist") continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) walk(full, exts, out);
		else if (exts.some((ext) => full.endsWith(ext))) out.push(full);
	}
	return out;
}

/** The props of each self-closing `<PanelToggleButton … />`, tag start → `/>`. */
export function* panelToggleElements(src) {
	const TAG = "<PanelToggleButton";
	let from = 0;
	for (;;) {
		const start = src.indexOf(TAG, from);
		if (start < 0) return;
		const end = src.indexOf("/>", start);
		if (end < 0) return;
		yield src.slice(start, end);
		from = end + 2;
	}
}

/**
 * The pure audit. `sources` is `[{ file, src }]` with repo-relative paths;
 * `baseline` is the always-live allowlist. Returns the three offender lists.
 */
export function auditPanelToggles({ sources, baseline }) {
	const undeclared = new Set();
	const handRolled = [];

	for (const { file, src } of sources) {
		if (/\bpanelToggleIcon\b/.test(src)) handRolled.push(file);
		for (const props of panelToggleElements(src)) {
			if (!/side=\{PanelSide\.Right\}/.test(props)) continue;
			if (/\bdisabled=/.test(props)) continue;
			undeclared.add(file);
		}
	}

	const baselineSet = new Set(baseline);
	return {
		handRolled,
		newViolations: [...undeclared].filter((f) => !baselineSet.has(f)),
		staleBaseline: baseline.filter((f) => !undeclared.has(f)),
	};
}

function main() {
	const appsDir = join(ROOT, "apps");
	const sources = readdirSync(appsDir)
		.flatMap((app) => walk(join(appsDir, app, "src"), [".ts", ".tsx"]))
		.filter((file) => !file.includes(".test."))
		.map((file) => ({ file: toPosix(file), src: readFileSync(file, "utf8") }));

	const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")).alwaysLive;
	const { handRolled, newViolations, staleBaseline } = auditPanelToggles({ sources, baseline });

	let failed = false;

	if (handRolled.length > 0) {
		failed = true;
		console.error(
			"✗ hand-rolled panel toggle(s) — build them with `createPanelToggleButton` / `<PanelToggleButton>`:",
		);
		for (const f of handRolled) console.error(`    ${f}`);
	}

	if (newViolations.length > 0) {
		failed = true;
		console.error(
			"✗ right-side panel toggle(s) that never declare availability — pass `disabled` (plus a `hint`\n  explaining it), or baseline the file in tools/panel-toggle-baseline.json if the panel is always live:",
		);
		for (const f of newViolations) console.error(`    ${f}`);
	}

	if (staleBaseline.length > 0) {
		failed = true;
		console.error(
			"✗ stale panel-toggle baseline — these files now declare availability; drop them from\n  tools/panel-toggle-baseline.json so the ratchet keeps its floor:",
		);
		for (const f of staleBaseline) console.error(`    ${f}`);
	}

	if (failed) process.exit(1);

	console.log(
		`✓ panel toggles: no hand-rolled toggles; every right-side toggle declares availability (${baseline.length} always-live by design).`,
	);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main();
}
