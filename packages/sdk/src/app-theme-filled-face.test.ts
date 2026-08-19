/**
 * The disabled face of a filled control, pinned at the primitive.
 *
 * `tools/check-accent-fill.mjs` stops an APP from fading a filled control away
 * with blanket `opacity`, but it can only send offenders somewhere better —
 * and it points them all at one rule. If that rule silently loses its explicit
 * face (or someone "simplifies" it back to an `opacity`), every migrated
 * control regresses at once and the gate still reports clean, because the apps
 * are still doing what it asked. That is the `F-486` shape: a check that
 * passes while the defect is live. So the face is asserted here, at the
 * declaration.
 *
 * The pair itself (`text.tertiary` on `surface.raised` ≥ 3:1) is held per
 * theme by `disabled-label-on-disabled-face` in `themes-contrast.test.ts`.
 * This test only asserts that the shared rule USES that pair.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(join(import.meta.dirname, "app-theme.css"), "utf8");

function ruleBody(selector: string): string {
	const at = CSS.indexOf(selector);
	expect(at, `${selector} is missing from app-theme.css`).toBeGreaterThan(-1);
	const open = CSS.indexOf("{", at);
	return CSS.slice(open + 1, CSS.indexOf("}", open));
}

describe("the shared filled-control disabled face", () => {
	const body = ruleBody(":root .bs-filled:disabled");

	it("declares both halves of the face rather than fading the control", () => {
		expect(body).toMatch(/background:\s*var\(--color-surface-raised\)/);
		expect(body).toMatch(/color:\s*var\(--color-text-tertiary\)/);
	});

	it("neutralises the inherited blanket opacity", () => {
		// `.bs-btn:disabled` sets `opacity: .55` for the unfilled variants, which
		// is fine there and wrong here — a filled control that keeps it fades the
		// declared face right back out, so the rule must reset it.
		expect(body).toMatch(/opacity:\s*1\b/);
	});

	it("covers the accent and danger button variants, not just the opt-in class", () => {
		const selectors = CSS.slice(0, CSS.indexOf("{", CSS.indexOf(":root .bs-filled:disabled")));
		expect(selectors).toContain(".bs-btn--primary:disabled");
		expect(selectors).toContain(".bs-btn--danger:disabled");
	});
});

describe("the shared accent action", () => {
	it("paints its label on accent.onFill, never the decorative accent", () => {
		const body = ruleBody(":root .bs-btn--primary {");
		expect(body).toMatch(/background:\s*var\(--accent-fill\)/);
		expect(body).toMatch(/color:\s*var\(--accent-fg\)/);
	});

	it("resolves --accent-fill to the theme-corrected fill token", () => {
		expect(CSS).toMatch(/--accent-fill:\s*var\(--color-accent-on-fill\)/);
	});
});
