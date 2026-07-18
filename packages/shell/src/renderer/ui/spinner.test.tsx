import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Spinner } from "./spinner";

describe("Spinner", () => {
	it("announces itself as a status with the localized default label", () => {
		const html = renderToStaticMarkup(<Spinner />);
		expect(html).toContain('role="status"');
		expect(html).toContain('aria-label="Loading…"');
		// Pure CSS ring — no SVG markup per the design-system spec.
		expect(html).not.toContain("<svg");
	});

	it("tracks font size by default (no inline width/height)", () => {
		const html = renderToStaticMarkup(<Spinner />);
		expect(html).not.toMatch(/style="[^"]*width/);
	});

	it("takes an explicit pixel size for region-level loaders", () => {
		const html = renderToStaticMarkup(<Spinner size={32} />);
		expect(html).toMatch(/style="[^"]*width:\s*32px/);
		expect(html).toMatch(/style="[^"]*height:\s*32px/);
	});

	it("uses a caller-supplied label over the default", () => {
		const html = renderToStaticMarkup(<Spinner label="Saving changes" />);
		expect(html).toContain('aria-label="Saving changes"');
	});

	it("is hidden from a11y when decorative (ancestor announces busy)", () => {
		const html = renderToStaticMarkup(<Spinner decorative />);
		expect(html).toContain('aria-hidden="true"');
		expect(html).not.toContain('role="status"');
		expect(html).not.toContain("aria-label");
	});

	it("merges a caller className onto the base class", () => {
		const html = renderToStaticMarkup(<Spinner className="button__spinner" />);
		expect(html).toMatch(/class="spinner button__spinner"/);
	});
});
