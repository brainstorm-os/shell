/**
 * Accent-fill contract — zero baseline. Two rules, one root cause.
 *
 * `S5` in the POLISH-DSN-13 fleet audit read "accent button labels fail
 * contrast in dark, and the disabled accent state is undefined". Both halves
 * turned out to be the same thing: there was no shared accent button face, so
 * every app that needed one invented it, and each invention made the same two
 * mistakes. `DS-contrast-1` fixed the TOKENS; nothing looked at whether the
 * apps used them. This does.
 *
 * 1. **A text label never sits on the decorative accent fill.** `--accent`
 *    (`accent.default`) is tuned as a fill under a GLYPH — WCAG 1.4.11's 3:1.
 *    Measured against `--accent-fg` it is 3.94 (default-light), 3.90
 *    (graphite), 3.74 (mint), 3.71 (porcelain), 3.56 (solar): every one under
 *    the 4.5:1 bar that TEXT requires. `--accent-fill` (`accent.onFill`) is the
 *    theme-corrected fill 12.17 added for exactly this case. So a rule that
 *    sets both a `background: var(--accent…)` and a `color: var(--accent-fg…)`
 *    is by construction a label on the wrong fill — nineteen rules across eight
 *    files were, when this gate was written.
 *
 * 2. **A filled control never dims itself with blanket `opacity`.** On an
 *    unfilled control that is fine: ink fades against the page and stays
 *    legible. On a filled one it fades the fill and the label TOGETHER, so the
 *    result is undefined — whatever the two wash out to. That is the state
 *    Chat's send glyph dissolved into at ~1.3:1. Filled controls carry
 *    `bs-filled` and inherit the declared face from `app-theme.css`
 *    (`surface.raised` + `text.tertiary`, the pair
 *    `disabled-label-on-disabled-face` holds at 3:1 in every theme).
 *
 * Both are pure CSS arithmetic with no screenshot needed, which is the whole
 * argument for a gate: the defect shipped to users precisely because no test
 * looked. Where a static check genuinely CANNOT see the defect the audit says
 * so and leaves it on screenshot review — that honesty is what `F-486` cost.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** `background: var(--accent)` / `var(--accent, <fallback>)` — the decorative
 *  fill. `--accent-fill`, `--accent-soft`, `--accent-strong` and friends are
 *  deliberately NOT matched: the boundary is the exact token name. */
const DECORATIVE_FILL = /background(?:-color)?\s*:\s*var\(\s*--accent\s*[,)]/;
/** A text label painted in the on-accent ink. The leading class excludes
 *  `border-color` / `-webkit-text-fill-color` and other `*color` properties. */
const ON_ACCENT_INK = /(?:^|[^-\w])color\s*:\s*var\(\s*--accent-fg\s*[,)]/;
/** A filled control declares its fill from an accent or danger token. */
const FILLED =
	/background(?:-color)?\s*:\s*var\(\s*--(accent|accent-fill|accent-strong|danger)\s*[,)]/;
const BLANKET_OPACITY = /(?:^|[^-\w])opacity\s*:\s*(0?\.\d+|0)\s*[;}]/;

function walk(dir, out = []) {
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return out;
	}
	for (const entry of entries) {
		if (entry === "node_modules" || entry === "dist" || entry === "out") continue;
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) walk(full, out);
		else if (full.endsWith(".css")) out.push(full);
	}
	return out;
}

/** Flat rule split. Good enough because every construct this gate reads about
 *  — a declaration block with a `background` and a `color` — is flat; nesting
 *  (`@media`, `@supports`) only wraps such blocks, it never splits them. */
export function rules(source) {
	const out = [];
	for (const m of source.matchAll(/([^\n{}]+)\{([^{}]*)\}/g)) {
		out.push({
			selector: m[1].trim(),
			body: m[2],
			line: source.slice(0, m.index).split("\n").length,
		});
	}
	return out;
}

/** The `.foo` / `.foo--bar` stems a selector paints, so a `:disabled` rule can
 *  be matched back to the base rule that declared the fill. */
function stems(selector) {
	return selector
		.split(",")
		.map(
			(one) =>
				one
					.trim()
					.split(/[\s>+~]/)
					.pop() ?? "",
		)
		.map((one) => one.replace(/[:[].*$/, ""))
		.filter((one) => one.startsWith("."));
}

export function findOffences(source) {
	const all = rules(source);
	const filledStems = new Set();
	for (const rule of all) {
		if (FILLED.test(rule.body)) for (const stem of stems(rule.selector)) filledStems.add(stem);
	}
	const offences = [];
	for (const rule of all) {
		if (DECORATIVE_FILL.test(rule.body) && ON_ACCENT_INK.test(rule.body)) {
			offences.push({
				line: rule.line,
				selector: rule.selector,
				kind: "text label on the decorative --accent fill (use --accent-fill)",
			});
		}
		if (!rule.selector.includes(":disabled") || !BLANKET_OPACITY.test(rule.body)) continue;
		if (stems(rule.selector).some((stem) => filledStems.has(stem))) {
			offences.push({
				line: rule.line,
				selector: rule.selector,
				kind: "filled control dimmed by blanket opacity (carry `bs-filled`)",
			});
		}
	}
	return offences;
}

function main() {
	const roots = [
		...readdirSync("apps").map((app) => join("apps", app, "src")),
		...readdirSync("packages").map((pkg) => join("packages", pkg, "src")),
	];
	const files = roots.flatMap((root) => walk(root));
	const offenders = [];
	for (const file of files) {
		const raw = readFileSync(file, "utf8");
		if (!raw.includes("--accent") && !raw.includes("--danger")) continue;
		for (const o of findOffences(raw)) {
			offenders.push(`${file}:${o.line} — ${o.selector} — ${o.kind}`);
		}
	}

	if (offenders.length > 0) {
		console.error(
			"✗ accent-fill: a label on an accent fill uses --accent-fill (accent.onFill),\n" +
				"  and a filled control declares its disabled face instead of fading itself away.\n" +
				"  See `:root .bs-filled:disabled` in packages/sdk/src/app-theme.css.\n",
		);
		for (const o of offenders) console.error(`    ${o}`);
		process.exit(1);
	}
	console.log(`✓ accent-fill: ${files.length} stylesheets clean.`);
}

if (process.argv[1]?.endsWith("check-accent-fill.mjs")) main();
