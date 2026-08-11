/**
 * Node-label legibility contract (POLISH-DSN-13 — "Graph paints node titles
 * straight into the node tangle").
 *
 * The regression this guards: `.graph-canvas__label` was a bare `<div>` with
 * `color: currentColor` and **no** surface of its own, positioned at
 * `node.y + radius + 4` — i.e. deliberately painted over whatever discs and
 * edges happen to sit under it. `declutterLabels` only resolves label-vs-
 * LABEL overlap; it never tests a label box against a node disc or an edge,
 * so in any dense region the caption landed on top of the graph and was
 * unreadable.
 *
 * The fix is a real chip: padding + radius + the elevated surface + a subtle
 * border + the normal text colour, so the caption reads against whatever is
 * beneath it. This mirrors the whiteboard edge-label pill (a `roundRect`
 * filled with the background and stroked with the edge colour) — one visual
 * idiom for "text floating over a canvas scene" across both canvas apps.
 *
 * The SVG renderer (`?renderer=svg`, the legacy preview path) had the exact
 * same defect in `<text fill="currentColor">` form. SVG text can't take
 * padding/background, so it gets the equivalent: a `paint-order: stroke`
 * halo in the same surface colour.
 *
 * Both themes are covered without a screenshot: the chip's pair is exactly
 * `--color-text-primary` on `--color-background-elevated` (via the `--text` /
 * `--bg-elev` app-theme aliases), which is the `text-on-elevated` entry in
 * `CONTRAST_PAIRS` — already held at WCAG AA across all fourteen built-in
 * themes by `packages/tokens/src/themes-contrast.test.ts`. Deriving the chip
 * from that pair is why it can't be legible in the one theme someone
 * eyeballed and broken in the rest.
 *
 * Same posture as `apps/files/src/styles-toolbar-row.test.ts`: a regression
 * here must be a reviewed decision, not a silent one.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LABEL_MAX_WIDTH_PX, estimateLabelWidth, labelBoxHeight } from "./label-declutter";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const CSS_PATH = join(SRC_DIR, "..", "styles.css");
const PIXI_PATH = join(SRC_DIR, "pixi-renderer.ts");

/** Every top-level rule body whose selector list contains `selector`.
 *  Comments are stripped first — the rule comments in this stylesheet quote
 *  CSS and would confuse the brace scan. */
function ruleBodies(css: string, selector: string): string[] {
	const bodies: string[] = [];
	const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
	const re = /([^{}]+)\{([^{}]*)\}/g;
	for (const match of stripped.matchAll(re)) {
		const selectors = (match[1] ?? "").trim();
		if (selectors.split(",").some((s) => s.trim() === selector)) {
			bodies.push(match[2] ?? "");
		}
	}
	return bodies;
}

function onlyBody(css: string, selector: string): string {
	const bodies = ruleBodies(css, selector);
	expect(bodies.length, `expected exactly one rule for \`${selector}\``).toBe(1);
	return bodies[0] ?? "";
}

/** Custom properties the chip is allowed to name. Every one of these is a
 *  real theme token (`packages/tokens`, flattened as `--color-*`/`--space-*`/
 *  `--radius-*`) or an app-theme alias (`packages/sdk/src/app-theme.css`).
 *  A phantom name renders via its `var(--x, fallback)` in the one theme you
 *  eyeballed and breaks in every other. */
const KNOWN_VARS = new Set([
	"--text-size-xs",
	"--text-family-ui",
	"--space-0_5",
	"--space-1",
	"--radius-sm",
	"--bg-elev",
	"--text",
	"--border-width",
	"--color-border-subtle",
]);

describe("graph node labels read against the tangle beneath them", () => {
	const css = readFileSync(CSS_PATH, "utf8");
	const pixi = readFileSync(PIXI_PATH, "utf8");

	it("the pixi label is a chip: surface, padding, radius, text colour", () => {
		const body = onlyBody(css, ".graph-canvas__label");
		expect(
			body,
			"a label painted over discs and edges needs its own surface — without a background the text is unreadable in any dense region",
		).toMatch(/(^|\s)background:\s*var\(--bg-elev\)/m);
		expect(body, "the chip needs horizontal breathing room around the glyphs").toMatch(
			/(^|\s)padding:\s*\S+/m,
		);
		expect(body, "the chip's corners come from the radius scale").toMatch(
			/border-radius:\s*var\(--radius-\w+\)/,
		);
		expect(
			body,
			"the chip must state the normal text colour — `currentColor` inherits whatever the canvas host happens to carry",
		).toMatch(/(^|\s)color:\s*var\(--text\)/m);
		expect(body, "a hairline border separates the chip from a same-toned disc").toMatch(
			/(^|\s)border:\s*var\(--border-width\)/m,
		);
	});

	// The de-clutter pass measures a box in TS; the chip paints from CSS. Two
	// sources for one footprint, so they are pinned to each other here: if the
	// chip's padding, border or clamp changes, the box math has to move with it
	// or the overlap test silently measures something that isn't on screen.
	it("the de-clutter box math mirrors what the chip actually paints", () => {
		const body = onlyBody(css, ".graph-canvas__label");
		const maxWidth = /max-width:\s*(\d+)px/.exec(body)?.[1];
		expect(
			Number(maxWidth),
			"LABEL_MAX_WIDTH_PX in label-declutter.ts must equal the chip's CSS max-width",
		).toBe(LABEL_MAX_WIDTH_PX);
		expect(
			body,
			"the chip constants in label-declutter.ts assume `padding: var(--space-0_5) var(--space-1)` (2px / 4px) and a 1px border",
		).toMatch(/padding:\s*var\(--space-0_5\)\s+var\(--space-1\)/);
		expect(estimateLabelWidth(""), "an empty label is exactly the chip's own footprint").toBe(
			2 * (4 + 1),
		);
		expect(labelBoxHeight(13), "a 13px line box paints 13 + 2×(2 + 1) tall").toBe(19);
	});

	it("the chip names only tokens that exist", () => {
		const body = onlyBody(css, ".graph-canvas__label");
		for (const [, name] of body.matchAll(/var\((--[a-z0-9_-]+)/g)) {
			expect(KNOWN_VARS.has(name ?? ""), `\`${name}\` is not a known theme token/alias`).toBe(true);
		}
	});

	it("the renderer does not pin an inline colour over the chip", () => {
		expect(
			pixi,
			"an inline `style.color` beats the stylesheet — the chip's colour must come from CSS so it tracks the theme",
		).not.toMatch(/style\.color\s*=/);
	});

	it("the svg label carries the equivalent halo", () => {
		const body = onlyBody(css, ".graph-canvas__labels text");
		expect(
			body,
			"SVG text takes no padding/background, so the legacy `?renderer=svg` path gets a paint-order halo instead — the same defect otherwise",
		).toMatch(/paint-order:\s*stroke/);
		expect(body, "the halo is drawn in the same surface colour as the pixi chip").toMatch(
			/stroke:\s*var\(--bg-elev\)/,
		);
		expect(body, "a halo with no width paints nothing").toMatch(/stroke-width:\s*\S+/);
	});

	it("keeps the chip cheap enough for the 600-node cap", () => {
		const body = onlyBody(css, ".graph-canvas__label");
		expect(
			body,
			"a per-label backdrop-filter is a separate GPU pass per chip — 150 of them per frame at the label cap",
		).not.toMatch(/backdrop-filter/);
		expect(body, "a per-label box-shadow costs a blur pass per chip every frame").not.toMatch(
			/box-shadow/,
		);
	});
});
