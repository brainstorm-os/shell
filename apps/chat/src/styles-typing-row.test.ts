/**
 * Chats-4 — the typing indicator is an in-flow row of fixed height between
 * the transcript and the composer. An absolutely positioned label painted
 * over the last message once; a row with no reserved height makes the list
 * jump as people start and stop typing.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CSS_PATH = join(dirname(fileURLToPath(import.meta.url)), "styles.css");

function rule(css: string, selector: string): string {
	const start = css.indexOf(`${selector} {`);
	expect(start).toBeGreaterThan(-1);
	return css.slice(start, css.indexOf("}", start));
}

describe("chat typing row", () => {
	const css = readFileSync(CSS_PATH, "utf8");

	it("is in flow with a reserved height, never an overlay", () => {
		const typing = rule(css, ".chat__typing");
		expect(typing).not.toContain("position:");
		expect(typing).toMatch(/\n\theight: \d+px;/);
		expect(typing).toContain("flex-shrink: 0;");
	});
});
