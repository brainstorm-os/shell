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
 * ── The second shape: a collapsed grid track ────────────────────────────
 *
 * The rule above keys on `translateX` alone, and that blind spot shipped a
 * live defect: Mailbox never translates anything. It collapses its folder
 * rail by animating the GRID — `.mb-app__panes--rail-closed
 * { grid-template-columns: 0px 340px 1fr }` — and the rail's own
 * `overflow-x: hidden` clips the buttons to invisibility while leaving every
 * one of them rendered, tabbable and announced. The translate-only ratchet
 * reported "0 violations" over that file, which is the worst failure mode a
 * ratchet has: certifying a class it cannot see (cf. F-486).
 *
 * So a second rule, for the shape that has no transform:
 *
 *   A rule that sizes a `grid-template-columns` / `-rows` track to zero must
 *   be accompanied, IN THE SAME FILE, by a rule that carries the guard and is
 *   gated on the same state — every state token of the collapsing selector
 *   (its `[data-…]` conditions and `--modifier` / `.is-…` classes) must also
 *   appear in the guarding selector.
 *
 * That is the one deliberate cross-rule inference here, and it is bounded:
 * the collapsing rule styles the GRID CONTAINER, which stays visible, so its
 * own block *cannot* carry the guard — a per-block rule would be unsatisfiable.
 * Same state + same file is the tightest join that is still checkable. A zero
 * track on a selector with no state token at all is reported, because there is
 * nothing to attribute the guard to.
 *
 * Zeros inside `minmax(0, 1fr)` / `var(--w, 0)` / `repeat(…)` are stripped
 * before the track scan — those are floors and fallbacks, not collapses.
 *
 * ── What is NOT covered ─────────────────────────────────────────────────
 *
 * Say it here rather than leave it silent; a gap you know about is a gap the
 * next reader can close.
 *
 *   · A panel hidden by moving it with `inset`/`left`/`margin`, or by
 *     animating `width`/`max-width`/`flex-basis` to 0 (nothing in the repo
 *     does this today — the house pattern is transform or grid track).
 *   · A translate by a variable width (`calc(-1 * var(--x-width))`). NOT
 *     matched on purpose — Graph's `.zoom-controls` uses exactly that shape
 *     while fully visible, so it is a false positive by construction.
 *   · A guard that reaches the panel only through code — a React `inert` on a
 *     sibling modifier class the collapsing selector never mentions. This is
 *     unknowable from CSS, so it is BASELINED, and every baseline key must
 *     carry a written reason naming where the real guard lives
 *     (`tools/offcanvas-guard-baseline.json`). A reasonless key fails the run:
 *     an allowlist that does not have to explain itself is a mute button.
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

/** Drop every `fn(…)` — `minmax(0, 1fr)`, `var(--w, 248px)`, `repeat(…)` —
 *  so a zero INSIDE a function is never read as a zero track. */
const stripFunctions = (value) => {
	let out = value;
	for (let pass = 0; pass < 8; pass++) {
		const next = out.replace(/[\w-]*\([^()]*\)/g, " ");
		if (next === out) break;
		out = next;
	}
	return out;
};

/**
 * The value of every `grid-template-columns` / `-rows` declaration in a block
 * body that lists a track sized to zero — the second way a panel is collapsed
 * (the first being `transform: translateX(±100%)`).
 */
export const collapsedTrackValues = (body) =>
	[...body.matchAll(/(?:^|;)\s*grid-template-(?:columns|rows)\s*:\s*([^;]*)/g)]
		.map((m) => m[1])
		.filter((value) =>
			stripFunctions(value)
				.split(/[\s,]+/)
				.some((track) => /^0(?:px|fr|%|em|rem|vw|vh|ch)?$/i.test(track)),
		);

/**
 * The state conditions a selector is gated on: attribute selectors
 * (`[data-nav-open="false"]`) and modifier classes (`.x--closed`, `.is-open`).
 * A plain block/element class is not a state — `.window` says nothing about
 * open vs closed — so it is not a token.
 */
export const stateTokens = (selector) => [
	...(selector.match(/\[[^\]]*\]/g) ?? []),
	...(selector.match(/\.[\w-]*(?:--|\.is-)[\w-]+|\.is-[\w-]+/g) ?? []),
];

const hasGuard = (body) =>
	/(?:^|;)\s*visibility\s*:\s*hidden\b/i.test(body) || /(?:^|;)\s*display\s*:\s*none\b/i.test(body);

/**
 * The baseline is `{ "<file>:<selector>": "<why the guard is unreachable from
 * the CSS>" }`. A key whose reason is missing or blank is rejected, so the
 * allowlist cannot be padded silently the way a plain array of keys can.
 */
export const unexplainedBaselineKeys = (entries) =>
	Object.entries(entries)
		.filter(([, why]) => typeof why !== "string" || why.trim().length === 0)
		.map(([key]) => key);

/** How the panel was taken off screen — the two shapes this ratchet knows. */
export const Shape = Object.freeze({
	Translate: "translate",
	Track: "collapsed-track",
});

/**
 * The pure audit. `sources` is `[{ file, src }]` with repo-relative paths;
 * `baseline` is the allowlist of `"<file>:<selector>"` keys.
 */
export function auditOffCanvasGuards({ sources, baseline }) {
	const offenders = [];
	for (const { file, src } of sources) {
		const blocks = [...declarationBlocks(src)];
		/** Every selector in this file whose block hides its subject. */
		const guardSelectors = blocks.filter((b) => hasGuard(b.body)).map((b) => b.selector);

		for (const { selector, body, line } of blocks) {
			if (transformValues(body).some(isOffCanvasTransform) && !hasGuard(body)) {
				offenders.push({ file, selector, line, shape: Shape.Translate, key: `${file}:${selector}` });
				continue;
			}
			if (collapsedTrackValues(body).length === 0) continue;
			// The collapsing rule styles the GRID, not the panel, so its own
			// block can never carry the guard. The guard must live on a rule
			// gated by the same state — `.x--closed .panel { visibility: hidden }`.
			const tokens = stateTokens(selector);
			const guarded =
				tokens.length > 0 && guardSelectors.some((g) => tokens.every((token) => g.includes(token)));
			if (guarded) continue;
			offenders.push({ file, selector, line, shape: Shape.Track, key: `${file}:${selector}` });
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

	const entries = JSON.parse(readFileSync(BASELINE_PATH, "utf8")).guardedElsewhere;
	const unexplained = unexplainedBaselineKeys(entries);
	const baseline = Object.keys(entries);
	const { newViolations, staleBaseline } = auditOffCanvasGuards({ sources, baseline });

	let failed = false;

	const translate = newViolations.filter((o) => o.shape === Shape.Translate);
	const track = newViolations.filter((o) => o.shape === Shape.Track);

	if (translate.length > 0) {
		failed = true;
		console.error(
			"✗ off-canvas panel(s) that stay focusable — a rule slides the subject fully off its own box\n  but leaves it in the tab order and the a11y tree. Add `visibility: hidden` to the SAME block (and\n  list `visibility` in the panel's transition so the slide still animates), or `display: none` if the\n  panel need not animate out:",
		);
		for (const o of translate) console.error(`    ${o.file}:${o.line}  ${o.selector}`);
	}

	if (track.length > 0) {
		failed = true;
		console.error(
			"✗ collapsed grid track(s) whose panel stays focusable — the rule sizes a track to 0, which\n  clips the panel to nothing but leaves every control inside it rendered, tabbable and announced.\n  Add `visibility: hidden` to a rule under the SAME state — `.x--closed .panel { … }` — and list\n  `visibility` in that panel's transition. If the guard genuinely lives outside CSS (a React `inert`\n  on a sibling modifier class), add the rule to tools/offcanvas-guard-baseline.json WITH the reason:",
		);
		for (const o of track) console.error(`    ${o.file}:${o.line}  ${o.selector}`);
	}

	if (unexplained.length > 0) {
		failed = true;
		console.error(
			"✗ off-canvas baseline entries with no reason — every allowlisted rule must say where its\n  guard actually lives, or the baseline is just a mute button:",
		);
		for (const k of unexplained) console.error(`    ${k}`);
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
		`✓ off-canvas guards: every panel slid off-canvas or collapsed to a zero track is also removed from the tab order (${sources.length} stylesheets scanned, ${baseline.length} explained exception(s)).`,
	);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	main();
}
