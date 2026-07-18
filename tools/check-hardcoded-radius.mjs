/**
 * Zero-baseline guard: no hardcoded pixel `border-radius` in product CSS.
 *
 * The radius scale is tokenised (2/4/8/12/16 — `--radius-xs…xl`, `--radius-full`)
 * and every control face must reference it; invented radii (7px/10px chat
 * buttons, owner report 2026-07-18) drift the product's corner language app
 * by app. Allowed: `0`, `1px` (hairline nubs), percentage radii (squircles,
 * circles), `999px`/`9999px` pills, and `var(--radius-…)` references.
 *
 * Same posture as check-css-tokens.mjs: fails loud on ANY new offender.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["apps", "packages/sdk/src", "packages/shell/src", "packages/editor/src"];
const ALLOWED = /^(0|1px|50%|[0-9.]+%|999px|9999px|inherit)$/;

/** A value is fine when it's a token/calc-over-token reference or an
 *  allowed literal (after shedding `!important`). */
function allowed(raw) {
	const value = raw.replace(/\s*!important\s*$/, "").trim();
	if (value.startsWith("var(")) return true;
	if (value.startsWith("calc(") && value.includes("var(--radius")) return true;
	return ALLOWED.test(value);
}

function* cssFiles(dir) {
	for (const name of readdirSync(dir)) {
		if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
		const path = join(dir, name);
		const st = statSync(path);
		if (st.isDirectory()) yield* cssFiles(path);
		else if (name.endsWith(".css")) yield path;
	}
}

const offenders = [];
for (const root of ROOTS) {
	for (const file of cssFiles(root)) {
		const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
		let lineNo = 0;
		for (const line of css.split("\n")) {
			lineNo++;
			const m = line.match(/border-radius:\s*([^;]+);/);
			if (!m) continue;
			const value = m[1].trim();
			if (allowed(value)) continue;
			// Multi-value shorthand: every part must be a token or allowed literal.
			if (!value.startsWith("calc(") && value.split(/\s+/).every(allowed)) continue;
			offenders.push(`${file}:${lineNo} border-radius: ${value}`);
		}
	}
}

if (offenders.length > 0) {
	console.error("✗ hardcoded border-radius (use the --radius-* scale):");
	for (const o of offenders) console.error(`  ${o}`);
	process.exit(1);
}
console.log("✓ border-radius: every value rides the token scale");
