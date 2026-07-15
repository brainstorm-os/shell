/**
 * `index.html`'s Content-Security-Policy meta tag is the load-bearing
 * deny-by-default for the Notes app renderer. Two directives are pinned
 * by regression-fences because their absence breaks user-visible
 * features silently:
 *
 *   - `font-src 'self' data:` — KaTeX bundles its math fonts as base64
 *     `data:` URLs. With no explicit `font-src`, CSP falls back to
 *     `default-src 'self'` and blocks every KaTeX glyph. Surfaces as
 *     equations rendering in a fallback font. Found via error-log
 *     triage 2026-05-21 (33 lifetime hits across daily sessions).
 *
 *   - `script-src 'self'` — no `'unsafe-eval'` or `'unsafe-inline'`,
 *     defense against an XSS in the editor pulling in arbitrary code.
 *
 * If you intentionally need to relax a directive, update this test in
 * the same PR so the test is the audit trail.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const INDEX_HTML = readFileSync(join(__dirname, "index.html"), "utf-8");

function csp(): string {
	const m = INDEX_HTML.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
	if (!m || typeof m[1] !== "string") {
		throw new Error("CSP meta tag not found in apps/notes/src/index.html");
	}
	return m[1];
}

describe("apps/notes Content-Security-Policy", () => {
	it("declares `font-src 'self' data:` (KaTeX inline base64 fonts)", () => {
		expect(csp()).toMatch(/font-src 'self' data:/);
	});

	it("keeps `default-src 'self'` (deny-by-default)", () => {
		expect(csp()).toMatch(/default-src 'self'/);
	});

	it("keeps `script-src 'self'` (no `unsafe-eval` / `unsafe-inline`)", () => {
		const policy = csp();
		expect(policy).toMatch(/script-src 'self'/);
		expect(policy).not.toMatch(/script-src[^;]*'unsafe-eval'/);
		expect(policy).not.toMatch(/script-src[^;]*'unsafe-inline'/);
	});

	it("allows Amplitude EU hosts for beta analytics (connect / script / worker)", () => {
		const policy = csp();
		expect(policy).toMatch(/connect-src[^;]*https:\/\/\*\.eu\.amplitude\.com/);
		expect(policy).toMatch(/script-src[^;]*https:\/\/cdn\.eu\.amplitude\.com/);
		expect(policy).toMatch(/worker-src 'self' blob:/);
	});
});
