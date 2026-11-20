/**
 * Row-grid contract — the list row's leading icon track is FIXED, and the
 * glyph host is never collapsed out of the grid.
 *
 * `grid-template-columns` is per row. When the first track was `auto` and
 * `.content-row__glyph:empty { display: none }` removed the host from the
 * grid, the NAME became the first grid item and sized to the icon track
 * while the Kind cell took the `1fr` lane — "H.. pdf  Today" with the file
 * name a sliver (the 0.15.0 release-shot regression, `h-01-after-import`).
 * Same posture as `styles-lane-fill.test.ts`: parse `styles.css`, fail on
 * a silent regression.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CSS_PATH = join(dirname(fileURLToPath(import.meta.url)), "styles.css");

function rules(css: string): { selectors: string[]; body: string }[] {
	const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
	const out: { selectors: string[]; body: string }[] = [];
	for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		out.push({
			selectors: (match[1] ?? "").split(",").map((s) => s.trim()),
			body: match[2] ?? "",
		});
	}
	return out;
}

describe("list row grid keeps a fixed icon track", () => {
	const css = readFileSync(CSS_PATH, "utf8");
	const all = rules(css);

	it(".content-row's first grid track is a fixed width, never auto", () => {
		const row = all.filter((r) => r.selectors.includes(".content-row"));
		const template = row
			.map((r) => /grid-template-columns:\s*([^;]+);/.exec(r.body)?.[1]?.trim())
			.find((v): v is string => Boolean(v));
		expect(template, ".content-row must declare grid-template-columns").toBeDefined();
		const first = (template ?? "").split(/\s+/)[0] ?? "";
		expect(first, `first track "${first}" must be fixed (px or a --space token)`).toMatch(
			/^(\d+px|var\(--space-[\w-]+\))$/,
		);
	});

	it("never collapses an empty .content-row__glyph out of the grid", () => {
		const collapse = all.filter(
			(r) =>
				r.selectors.some((s) => s.includes(".content-row__glyph:empty")) &&
				/display:\s*none/.test(r.body),
		);
		expect(collapse, "an empty glyph host must keep its grid slot").toHaveLength(0);
	});
});

describe("list row hover actions never cover a column", () => {
	const css = readFileSync(CSS_PATH, "utf8");
	const all = rules(css);
	const bodyOf = (selector: string): string =>
		all
			.filter((r) => r.selectors.includes(selector))
			.map((r) => r.body)
			.join("\n");

	it("the export grip is a real grid child of the list row, in the trailing track", () => {
		const body = bodyOf('.content-row[data-view-mode="list"] .content-row__export-grip');
		expect(body, "list-mode export grip rule missing").not.toBe("");
		expect(body).toMatch(/position:\s*static/);
		expect(body).toMatch(/grid-column:\s*-2\s*\/\s*-1/);
	});

	it("declares the actions track from the grip + ⋯ widths", () => {
		expect(bodyOf(".content-row")).toMatch(/--files-row-actions:\s*calc\(/);
	});

	it("no longer fakes the reservation with padding on the last cell", () => {
		const padded = all.filter((r) =>
			r.selectors.some((s) => s.includes(".content-row > span:last-child")),
		);
		expect(padded, "the trailing track replaces the last-cell padding").toHaveLength(0);
	});
});

describe("list row type icons match the folder glyph's optical size", () => {
	const css = readFileSync(CSS_PATH, "utf8");
	const all = rules(css);

	it("drops the squircle frame and zooms the inset first-party glyph in one-lane lists", () => {
		const rule = all.find((r) =>
			r.selectors.includes(
				'.content-row[data-view-mode="list"] .content-row__app-icon[data-inset-glyph="true"]',
			),
		);
		expect(rule, "list-mode app-icon rule missing").toBeDefined();
		expect(rule?.body).toMatch(/border:\s*(0|none)/);
		expect(rule?.body).toMatch(/background:\s*none/);
		expect(rule?.body).toMatch(/transform:\s*scale\(var\(--files-inset-glyph-zoom\)\)/);
	});
});
