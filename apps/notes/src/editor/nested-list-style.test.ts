import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Regression lock for "second-level bullets render two markers".
 *
 * Lexical models a nested list as a child <ul>/<ol> wrapped in its own
 * marker-less <li> carrying the `nested.listitem` theme class
 * (`notes__list-item--nested`). If that wrapper itself draws a list
 * marker, it stacks a bullet on top of the inner list's first item.
 * The fix is structural and lives entirely in CSS, so the guard is a
 * stylesheet-contract test (jsdom cannot compute list markers). It reads
 * the sheets the app actually loads: the shared editor theme plus the
 * app's own styles.css.
 */

const css = [
	"../../../../packages/editor/src/editor-theme.css",
	"../styles.css",
]
	.map((rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"))
	.join("\n")
	.replace(/\/\*[\s\S]*?\*\//g, "");

/** Returns the body of the first rule whose selector list is exactly
 *  `selector` (whitespace-normalised). */
function ruleBody(selector: string): string | null {
	const blocks = css.matchAll(/([^{}]+)\{([^{}]*)\}/g);
	for (const match of blocks) {
		const sel = match[1];
		const body = match[2];
		if (sel === undefined || body === undefined) continue;
		if (sel.trim().replace(/\s+/g, " ") === selector) return body;
	}
	return null;
}

describe("nested list marker styling", () => {
	it("the nested-wrapper <li> draws no marker of its own", () => {
		const body = ruleBody(".notes__list-item--nested");
		expect(body).not.toBeNull();
		expect(body).toMatch(/list-style:\s*none/);
		expect(body).not.toMatch(/list-style:\s*circle/);
	});

	it("depth-2 bullets are circle, depth-3+ are square (from the nested list, not the wrapper)", () => {
		expect(ruleBody(".notes__list-item--nested > .notes__list--bullet")).toMatch(
			/list-style:\s*circle/,
		);
		expect(
			ruleBody(".notes__list-item--nested .notes__list-item--nested > .notes__list--bullet"),
		).toMatch(/list-style:\s*square/);
	});

	it("nested ordered lists vary by depth (alpha then roman)", () => {
		expect(ruleBody(".notes__list-item--nested > .notes__list--numbered")).toMatch(
			/list-style:\s*lower-alpha/,
		);
		expect(
			ruleBody(".notes__list-item--nested .notes__list-item--nested > .notes__list--numbered"),
		).toMatch(/list-style:\s*lower-roman/);
	});
});
