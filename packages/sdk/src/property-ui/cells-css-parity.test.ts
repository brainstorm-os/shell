/**
 * Stylesheet-level guards for the rest ↔ edit layout parity of property
 * cells. jsdom cannot measure layout, so the invariants that made rows
 * jump when a cell entered edit mode are asserted against the source CSS:
 *
 * 1. The panel's one-line truncation rule must exempt the Multiline cell
 *    and its editor. When it applied to them, a Long-text value rested as
 *    ONE nowrap line but edited as ALL its lines — the row grew by N-1
 *    lines on click and every row below jumped.
 * 2. Every inline editor's padding must subtract the border it adds
 *    (`calc(<rest padding> - var(--border-width))`), or the edit face's
 *    text shifts 1px and a multiline row changes height by 2px.
 * 3. The "Empty" affordance is ONE face across every cell kind. Half the
 *    empties hardcoded `--text-size-sm` and half declared colour only,
 *    inheriting their cell's `--text-size-md` — so a single property block
 *    showed two different "Empty" sizes (Tasks: Duration Estimate/Logged
 *    against Status/Due/Project/Tags).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string): string => readFileSync(join(__dirname, rel), "utf8");

describe("property cell rest ↔ edit box parity (stylesheet invariants)", () => {
	it("the row-value truncation rule exempts the multiline cell and its editor", () => {
		const css = read("../properties-panel/properties-panel.css");
		const truncation = css
			.split("}")
			.find((block) => block.includes("text-overflow: ellipsis") && block.includes("row-value"));
		expect(truncation).toBeDefined();
		expect(truncation).toContain(":not(.bs-cell-multiline)");
		expect(truncation).toContain(":not(.bs-cell-multiline-input)");
	});

	it("every inline editor's padding subtracts the border width it adds", () => {
		const css = read("./cells.css");
		for (const editor of [".bs-cell-input", ".bs-cell-plain-input", ".bs-cell-multiline-input"]) {
			const blocks = css
				.split("}")
				.filter((block) => block.includes(`${editor} {`) || block.includes(`${editor},`));
			const padded = blocks.filter((block) => block.includes("padding:"));
			expect(padded.length).toBeGreaterThan(0);
			for (const block of padded) {
				expect(block).toMatch(/padding: calc\(var\(--space-[0-9_]+\) - var\(--border-width\)\)/);
			}
		}
	});
});

/** Every selector that styles a rendered `labels.cellEmpty` placeholder.
 *  `.bs-cell-formula--empty` is excluded on purpose — it paints an em-dash
 *  for an uncomputable formula, not the Empty affordance. */
const EMPTY_SELECTORS = [
	".bs-cell-pill--empty .bs-cell-pill-text",
	".bs-cell-plain--empty",
	".bs-cell-multiline--empty",
	".bs-cell-progress--empty .bs-cell-progress-text",
	".bs-cell-rating-empty",
	".bs-cell-tag-empty",
	".bs-cell-date-empty",
	".bs-cell-link-empty",
	".bs-cell-file-empty",
];

type CssRule = { selector: string; body: string; index: number };

const rules = (css: string): CssRule[] => {
	const stripped = css.replace(/\/\*[\s\S]*?\*\//g, (block) => " ".repeat(block.length));
	const out: CssRule[] = [];
	for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		out.push({
			selector: (match[1] ?? "").trim(),
			body: match[2] ?? "",
			index: match.index ?? 0,
		});
	}
	return out;
};

describe("property cell empty affordance (one face across every kind)", () => {
	const all = rules(read("./cells.css"));

	it("a single rule carries the face for every cell kind's Empty placeholder", () => {
		const shared = all.filter((rule) =>
			EMPTY_SELECTORS.every((selector) => rule.selector.includes(selector)),
		);
		expect(shared).toHaveLength(1);
		expect(shared[0]?.body).toContain("color: var(--text-faint)");
		expect(shared[0]?.body).toContain("font-size: var(--text-size-sm)");
	});

	it("no cell kind re-declares its own Empty size or colour", () => {
		for (const selector of EMPTY_SELECTORS) {
			const owners = all.filter(
				(rule) =>
					rule.selector.includes(selector) &&
					(rule.body.includes("font-size") || rule.body.includes("color")),
			);
			expect(owners, `${selector} is styled by ${owners.length} rules`).toHaveLength(1);
		}
	});

	it("the shared face is declared after the cell faces it has to override", () => {
		const shared = all.find((rule) =>
			EMPTY_SELECTORS.every((selector) => rule.selector.includes(selector)),
		);
		expect(shared).toBeDefined();
		// `.bs-cell-plain--empty` and `.bs-cell-plain` are equal specificity, so
		// only source order decides which font-size wins.
		const bases = all.filter(
			(rule) => /^\.bs-cell-[a-z]+$/.test(rule.selector) && rule.body.includes("font-size"),
		);
		expect(bases.length).toBeGreaterThan(0);
		for (const base of bases) {
			expect(base.index, `${base.selector} must precede the shared empty face`).toBeLessThan(
				shared?.index ?? -1,
			);
		}
	});
});
