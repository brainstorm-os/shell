/**
 * Off-canvas panel guard ratchet.
 *
 * The recurring bug (F-489): a collapsed sidebar / inspector is slid out of
 * view with `transform: translateX(±100%)` and nothing else. The subtree is
 * still rendered, so every row, button and resize handle inside it stays in
 * the tab order AND in the accessibility tree — a keyboard user tabs into a
 * panel they cannot see, at x = -240. `pointer-events: none` does not fix it
 * (it blocks the mouse only) and neither does `overflow: hidden` on an
 * ancestor. Nine apps shipped it independently.
 *
 * The rule, checked per declaration block and nothing else:
 *
 *   A rule that slides its subject off-canvas — a `transform` whose
 *   `translateX()` / `translate()` / `translate3d()` x-argument is ±100%
 *   (bare or inside a `calc()`) — must, in the SAME block, also declare
 *   `visibility: hidden` or `display: none`.
 *
 * Both of those remove the subtree from the tab order and the a11y tree, and
 * `visibility: hidden` keeps the box (so the slide still animates and layout
 * measurements still work) as long as the panel's transition lists
 * `visibility` — see the CSS in any of the fixed panels for the idiom:
 *
 *   transition:
 *       transform var(--motion-duration-normal, 180ms) ease,
 *       visibility var(--motion-duration-normal, 180ms) ease;
 *
 * `visibility` interpolates specially: with one endpoint `visible` the
 * element stays visible for the whole duration and snaps at the end, so the
 * panel slides OUT fully painted and slides IN visible from the first frame.
 *
 * Why CSS and not a React `inert` prop: several of these panels are hosted by
 * markup React does not own (Database's static `index.html`, Calendar's and
 * Tasks' slot `<div>`s), so a prop-level guard cannot reach them. Apps that
 * already pass `inert` + `aria-hidden` keep doing so — that is correct and
 * defends the React path; this ratchet guarantees the floor underneath it.
 *
 * Deliberately local to one block: no cross-file or cross-rule inference, so
 * a violation is a fact about the file, not a guess. The cost is that a panel
 * whose guard genuinely lives elsewhere must be baselined — the baseline is
 * checked in at zero and reported when stale.
 *
 * Not covered: a panel hidden by moving it with `inset`/`left`, or one that
 * translates by a variable width (`calc(-1 * var(--x-width))`). The latter is
 * NOT matched on purpose — Graph's `.zoom-controls` uses exactly that shape
 * while fully visible, so treating it as an off-canvas tell is a false
 * positive by construction.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = join(ROOT, "tools", "offcanvas-guard-baseline.json");

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

/** Blank out comments in place — same length, same newlines — so byte offsets
 *  and therefore reported line numbers still match the file on disk. */
const blankComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

/**
 * Every innermost declaration block, as `{ selector, body, line }`. Innermost
 * means it contains no nested `{` — so `@media`/`@supports` wrappers are
 * walked through rather than reported.
 */
export function* declarationBlocks(css, lineOffset = 0) {
	const src = blankComments(css);
	let depth = 0;
	let blockStart = -1;
	let segmentStart = 0;
	let nestedInBlock = false;

	for (let i = 0; i < src.length; i++) {
		const ch = src[i];
		if (ch === "{") {
			if (depth === 0) {
				blockStart = i;
				segmentStart = i + 1;
				nestedInBlock = false;
			} else if (depth === 1) {
				nestedInBlock = true;
			}
			depth++;
		} else if (ch === "}") {
			depth--;
			if (depth === 0 && blockStart >= 0) {
				if (!nestedInBlock) {
					const selector = src.slice(0, blockStart).split(/[}{;]/).pop().trim();
					yield {
						selector,
						body: src.slice(segmentStart, i),
						line: lineOffset + src.slice(0, blockStart).split("\n").length,
					};
				} else {
					// A wrapper (@media …): re-scan its inside as top-level.
					yield* declarationBlocks(
						src.slice(blockStart + 1, i),
						lineOffset + src.slice(0, blockStart + 1).split("\n").length - 1,
					);
				}
				blockStart = -1;
			}
			if (depth < 0) depth = 0;
		}
	}
}

/** The value of every `transform:` declaration in a block body. */
const transformValues = (body) =>
	[...body.matchAll(/(?:^|;)\s*transform\s*:\s*([^;]*)/g)].map((m) => m[1]);

/** True when the value slides its subject a full box-width off its own axis. */
export const isOffCanvasTransform = (value) =>
	/\btranslate(?:X|3d)?\(\s*(?:-\s*)?100%|\btranslate(?:X|3d)?\(\s*calc\([^)]*\b100%/i.test(value);

const hasGuard = (body) =>
	/(?:^|;)\s*visibility\s*:\s*hidden\b/i.test(body) || /(?:^|;)\s*display\s*:\s*none\b/i.test(body);

/**
 * The pure audit. `sources` is `[{ file, src }]` with repo-relative paths;
 * `baseline` is the allowlist of `"<file>:<selector>"` keys.
 */
export function auditOffCanvasGuards({ sources, baseline }) {
	const offenders = [];
	for (const { file, src } of sources) {
		for (const { selector, body, line } of declarationBlocks(src)) {
			if (!transformValues(body).some(isOffCanvasTransform)) continue;
			if (hasGuard(body)) continue;
			offenders.push({ file, selector, line, key: `${file}:${selector}` });
		}
	}
	const baselineSet = new Set(baseline);
	const keys = new Set(offenders.map((o) => o.key));
	return {
		newViolations: offenders.filter((o) => !baselineSet.has(o.key)),
		staleBaseline: baseline.filter((k) => !keys.has(k)),
	};
}

function main() {
	const files = [
		...readdirSync(join(ROOT, "apps")).flatMap((app) =>
			walk(join(ROOT, "apps", app, "src"), [".css"]),
		),
		...walk(join(ROOT, "packages", "sdk", "src"), [".css"]),
		...walk(join(ROOT, "packages", "editor", "src"), [".css"]),
	];
	const sources = files.map((file) => ({
		file: toPosix(file),
		src: readFileSync(file, "utf8"),
	}));

	const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")).guardedElsewhere;
	const { newViolations, staleBaseline } = auditOffCanvasGuards({ sources, baseline });

	let failed = false;

	if (newViolations.length > 0) {
		failed = true;
		console.error(
			"✗ off-canvas panel(s) that stay focusable — a rule slides the subject fully off its own box\n  but leaves it in the tab order and the a11y tree. Add `visibility: hidden` to the SAME block (and\n  list `visibility` in the panel's transition so the slide still animates), or `display: none` if the\n  panel need not animate out:",
		);
		for (const o of newViolations) console.error(`    ${o.file}:${o.line}  ${o.selector}`);
	}

	if (staleBaseline.length > 0) {
		failed = true;
		console.error(
			"✗ stale off-canvas baseline — these rules now carry the guard; drop them from\n  tools/offcanvas-guard-baseline.json so the ratchet keeps its floor:",
		);
		for (const k of staleBaseline) console.error(`    ${k}`);
	}

	if (failed) process.exit(1);

	console.log(
		`✓ off-canvas guards: every panel slid off-canvas is also removed from the tab order (${sources.length} stylesheets scanned).`,
	);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main();
}
