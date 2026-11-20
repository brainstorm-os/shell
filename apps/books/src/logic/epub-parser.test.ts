// @vitest-environment jsdom
/** parseEpub glue (9.21.2) — epub.js is mocked so this verifies the spine walk +
 *  body extraction WITHOUT a real EPUB. The regression guard: epub.js
 *  `section.load()` resolves to the section's `<html>` ELEMENT (not a Document),
 *  so `.body` is undefined — extraction must go through `querySelector("body")`. */
import { afterEach, describe, expect, it, vi } from "vitest";

/** A section whose load() returns the parsed `<html>` ELEMENT (epub.js's real
 *  shape — `section.contents = documentElement`), so `.body` is undefined. */
function htmlElement(markup: string): Element {
	return new DOMParser().parseFromString(markup, "text/html").documentElement;
}

const unload = vi.fn();
const destroy = vi.fn();

vi.mock("epubjs", () => ({
	default: () => ({
		ready: Promise.resolve(),
		loaded: {
			spine: Promise.resolve(),
			metadata: Promise.resolve(),
			navigation: Promise.resolve(null),
		},
		on: () => {},
		packaging: { metadata: { title: "Mock Book", creator: "Ada" } },
		load: () => Promise.resolve({}),
		destroy,
		spine: {
			get: (i: number) => {
				const sections = [
					"<html><head><title>x</title></head><body><h1>Ch 1</h1><p>Alpha</p></body></html>",
					"<html><body><p>Beta</p></body></html>",
				];
				if (i >= sections.length) return null;
				return { load: () => Promise.resolve(htmlElement(sections[i] as string)), unload };
			},
		},
	}),
}));

const { parseEpub } = await import("./epub-parser");

afterEach(() => vi.clearAllMocks());

describe("parseEpub", () => {
	it("extracts BookContent from the <html>-element section shape (not Document.body)", async () => {
		const content = await parseEpub(new Uint8Array([1, 2, 3]));
		expect(content.title).toBe("Mock Book");
		expect(content.author).toBe("Ada");
		expect(content.spine).toHaveLength(2);
		expect(content.spine[0]?.blocks.map((b) => b.text)).toEqual(["Ch 1", "Alpha"]);
		expect(content.spine[1]?.blocks.map((b) => b.text)).toEqual(["Beta"]);
		// Cleanup always runs.
		expect(unload).toHaveBeenCalledTimes(2);
		expect(destroy).toHaveBeenCalledTimes(1);
	});
});
