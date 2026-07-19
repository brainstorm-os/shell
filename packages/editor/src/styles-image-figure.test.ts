/**
 * Image-figure geometry contract (F-442). The bare `image` node's <figure>
 * shipped with NO rule at all — the UA default `margin: 1em 40px` pushed
 * wide images past the content column and an imported fixed pixel width
 * (Anytype plants carry one) rode uncapped off the pane edge. Docs planted
 * before IE-10e's image-block emission keep bare `image` nodes forever
 * (idempotent re-imports skip unchanged bodies), so the clamp must live in
 * the shared theme. Same posture as the Files lane-fill guard: removing
 * these declarations must be a reviewed decision, not a silent one.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CSS_PATH = join(dirname(fileURLToPath(import.meta.url)), "editor-theme.css");

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

describe("editor-theme image-figure geometry (F-442 guard)", () => {
	const css = readFileSync(CSS_PATH, "utf8");

	it("the figure kills the UA inline margins and clamps to the column", () => {
		const bodies = ruleBodies(css, ".bs-editor__image");
		expect(bodies.length).toBeGreaterThan(0);
		const joined = bodies.join("\n");
		expect(joined).toMatch(/margin:\s*[^;]*\b0\b/);
		expect(joined).toMatch(/max-width:\s*100%/);
	});

	it("the img clamps its imported fixed width and keeps aspect", () => {
		const bodies = ruleBodies(css, ".bs-editor__image img");
		expect(bodies.length).toBeGreaterThan(0);
		const joined = bodies.join("\n");
		expect(joined).toMatch(/max-width:\s*100%/);
		expect(joined).toMatch(/height:\s*auto/);
	});
});
