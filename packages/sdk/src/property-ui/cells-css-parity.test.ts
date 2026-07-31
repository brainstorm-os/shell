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
