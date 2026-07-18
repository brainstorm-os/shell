/**
 * Lane-fill contract — fixed-lane tile modes must fill their lane box.
 *
 * Grid / Gallery / Icon-list virtualize with FIXED pixel lanes
 * (@tanstack/react-virtual absolute-positions an outer tile div per
 * `TILE_METRICS`/`GALLERY_METRICS` height). The `.content-row__menu-host`
 * passes that height through (`height: 100%`), but the `.content-row`
 * inside must ALSO claim it — an auto-height row shrink-wraps at the
 * lane's top: the gallery flex:1 media band collapses to a thin strip and
 * the lane's remaining height reads as a dead gap under every tile (the
 * recurring "gallery layout broken" report, 2026-07-18), and grid's
 * `justify-content: center` goes inert.
 *
 * This parses `styles.css` and fails when any fixed-lane view-mode's
 * `.content-row` rule (or its menu-host pass-through) stops declaring
 * `height: 100%`. Same posture as `styles-rest-frames.test.ts`: a
 * regression here must be a reviewed decision, not a silent one.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CSS_PATH = join(dirname(fileURLToPath(import.meta.url)), "styles.css");
const FIXED_LANE_MODES = ["grid", "gallery", "icon-list"] as const;

/** Every top-level rule body whose selector list contains `selector`.
 *  Comments are stripped first — several rule comments quote CSS
 *  (`.content-row { height: 100% }`) and would confuse the brace scan. */
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

describe("fixed-lane tile modes fill their virtualized lane", () => {
	const css = readFileSync(CSS_PATH, "utf8");

	for (const mode of FIXED_LANE_MODES) {
		it(`${mode}: .content-row declares height: 100%`, () => {
			const rowSelector = `body[data-view-mode="${mode}"] .content-row`;
			const bodies = ruleBodies(css, rowSelector);
			expect(bodies.length, `no rule found for ${rowSelector}`).toBeGreaterThan(0);
			expect(
				bodies.some((b) => /height:\s*100%/.test(b)),
				`${rowSelector} must declare height: 100% (lane fill)`,
			).toBe(true);
		});

		it(`${mode}: .content-row__menu-host passes the lane height through`, () => {
			const hostSelector = `body[data-view-mode="${mode}"] .content-row__menu-host`;
			const bodies = ruleBodies(css, hostSelector);
			expect(bodies.length, `no rule found for ${hostSelector}`).toBeGreaterThan(0);
			expect(
				bodies.some((b) => /height:\s*100%/.test(b)),
				`${hostSelector} must declare height: 100% (lane pass-through)`,
			).toBe(true);
		});
	}
});
