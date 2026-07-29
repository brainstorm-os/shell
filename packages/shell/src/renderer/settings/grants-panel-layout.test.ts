/**
 * The grants popover exists to answer one question — "what can this app
 * read?" — and the answer is the SCOPE (`entities.read:brainstorm/Project/v1`),
 * not the verb. Truncating it renders the panel useless while still looking
 * fine (`entities.read:brainstorm/Pro…`, POLISH-LAY-7), so the layout rules
 * that keep the scope legible are pinned here: a wrapping capability line in a
 * text column that owns the row's free width.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("./settings.css", import.meta.url)), "utf8");

function ruleBlock(selector: string): string {
	const start = css.indexOf(selector);
	expect(start, `${selector} not found`).toBeGreaterThanOrEqual(0);
	const open = css.indexOf("{", start);
	const close = css.indexOf("}", open);
	return css.slice(open + 1, close);
}

describe("grants popover row layout", () => {
	const capability = ruleBlock(".grants-panel__capability {");

	it("never ellipsises the capability scope", () => {
		expect(capability).not.toMatch(/text-overflow\s*:\s*ellipsis/);
		expect(capability).not.toMatch(/white-space\s*:\s*nowrap/);
	});

	it("wraps the scope, breaking inside the long vendor/Type/v1 token", () => {
		expect(capability).toMatch(/white-space\s*:\s*normal/);
		expect(capability).toMatch(/overflow-wrap\s*:\s*anywhere/);
	});

	it("gives the text column the row's free width next to the Revoke button", () => {
		expect(ruleBlock(".grants-panel__row {")).toMatch(
			/grid-template-columns\s*:\s*1fr\s+auto\s*;/,
		);
	});

	it("stacks capability over source in one shrinkable text column", () => {
		const text = ruleBlock(".grants-panel__row-text {");
		expect(text).toMatch(/flex-direction\s*:\s*column/);
		expect(text).toMatch(/min-width\s*:\s*0/);
	});
});
