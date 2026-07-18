import { describe, expect, it } from "vitest";
import { buildFrameSrcDoc, hasRemoteContent } from "./remote-content";

describe("hasRemoteContent", () => {
	it("detects remote images, links, and css urls", () => {
		expect(hasRemoteContent('<img src="https://tracker.example.com/p.gif">')).toBe(true);
		expect(hasRemoteContent('<img src="//cdn.example.com/p.gif">')).toBe(true);
		expect(hasRemoteContent('<div style="background:url(http://x.com/a.png)">')).toBe(true);
	});

	it("ignores local data:/cid: content", () => {
		expect(hasRemoteContent('<img src="data:image/png;base64,AAAA">')).toBe(false);
		expect(hasRemoteContent('<img src="cid:logo123">')).toBe(false);
		expect(hasRemoteContent("<p>plain text only</p>")).toBe(false);
		expect(hasRemoteContent("")).toBe(false);
	});
});

describe("buildFrameSrcDoc", () => {
	it("blocks remote by default (img-src has no https)", () => {
		const doc = buildFrameSrcDoc("<p>hi</p>", false);
		expect(doc).toContain("Content-Security-Policy");
		expect(doc).toContain("img-src data: cid:;");
		expect(doc).not.toContain("img-src data: cid: https:");
	});

	it("permits remote images once the user opts in", () => {
		const doc = buildFrameSrcDoc("<p>hi</p>", true);
		expect(doc).toContain("img-src data: cid: https:");
	});

	it("hides remote <img> elements in blocked mode instead of painting broken glyphs", () => {
		const blocked = buildFrameSrcDoc("<p>hi</p>", false);
		expect(blocked).toContain('img[src^="http" i]');
		const shown = buildFrameSrcDoc("<p>hi</p>", true);
		expect(shown).not.toContain('img[src^="http" i]');
	});

	it("strips author script / base / meta-http-equiv overrides", () => {
		const hostile =
			'<base href="https://evil.com/"><meta http-equiv="refresh" content="0;url=https://evil.com"><script>steal()</script><p>body</p>';
		const doc = buildFrameSrcDoc(hostile, false);
		expect(doc).not.toContain("<base");
		expect(doc).not.toMatch(/http-equiv="refresh"/);
		expect(doc).not.toContain("steal()");
		expect(doc).toContain("<p>body</p>");
	});

	it("never enables scripts (no script-src in the frame CSP)", () => {
		const doc = buildFrameSrcDoc("<p>hi</p>", true);
		expect(doc).toContain("default-src 'none'");
		expect(doc).not.toContain("script-src");
	});
});
