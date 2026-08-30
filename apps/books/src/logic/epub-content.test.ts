// @vitest-environment jsdom
/** EPUB content extraction (9.21.2) — htmlToBlocks turns section XHTML into
 *  Heading/Paragraph blocks; bookContentFrom assembles BookContent + drops
 *  text-less sections. */
import { describe, expect, it } from "vitest";
import { BlockKind } from "./content";
import { bookContentFrom, htmlToBlocks } from "./epub-content";

describe("htmlToBlocks", () => {
	it("maps headings and paragraphs, collapsing whitespace", () => {
		const blocks = htmlToBlocks("<h1>Chapter\n One</h1><p>Hello   world.</p><p>Second.</p>");
		expect(blocks).toEqual([
			{ kind: BlockKind.Heading, text: "Chapter One" },
			{ kind: BlockKind.Paragraph, text: "Hello world." },
			{ kind: BlockKind.Paragraph, text: "Second." },
		]);
	});

	it("descends through generic containers without duplicating nested text", () => {
		const blocks = htmlToBlocks("<div><section><h2>Title</h2><p>Body</p></section></div>");
		expect(blocks.map((b) => b.text)).toEqual(["Title", "Body"]);
	});

	// FB2\u2192EPUB converters (most Russian-language EPUBs, and plenty of
	// others) mark chapter titles as a classed div rather than an <h*>. The
	// walker used to descend past a div holding only text and emit nothing,
	// so every chapter title in such a book was silently deleted.
	it("reads a title-classed container as a heading", () => {
		const blocks = htmlToBlocks('<div class="title2">  Chapter One  </div><p>Body</p>');
		expect(blocks).toEqual([
			{ kind: BlockKind.Heading, text: "Chapter One" },
			{ kind: BlockKind.Paragraph, text: "Body" },
		]);
	});

	it("reads a title-classed paragraph as a heading", () => {
		const blocks = htmlToBlocks('<p class="chapter-title">Annotation</p>');
		expect(blocks).toEqual([{ kind: BlockKind.Heading, text: "Annotation" }]);
	});

	it("keeps a container's own loose text instead of dropping it", () => {
		const blocks = htmlToBlocks("<div>Loose text<p>Nested</p>More loose</div>");
		expect(blocks.map((b) => b.text)).toEqual(["Loose text", "Nested", "More loose"]);
	});

	it("treats inline markup as part of the surrounding text run", () => {
		const blocks = htmlToBlocks("<div>Hello <em>brave</em> <a href='#x'>world</a></div>");
		expect(blocks).toEqual([{ kind: BlockKind.Paragraph, text: "Hello brave world" }]);
	});

	it("does not double-count text claimed by a nested block", () => {
		const blocks = htmlToBlocks("<div><p>Only once</p></div>");
		expect(blocks.map((b) => b.text)).toEqual(["Only once"]);
	});

	it("skips script/style and empty blocks, treats li as paragraphs", () => {
		const blocks = htmlToBlocks(
			"<style>.x{}</style><p></p><ul><li>One</li><li>Two</li></ul><script>x()</script>",
		);
		expect(blocks.map((b) => b.text)).toEqual(["One", "Two"]);
	});

	it("falls back to a single paragraph for bare text", () => {
		expect(htmlToBlocks("just some loose text")).toEqual([
			{ kind: BlockKind.Paragraph, text: "just some loose text" },
		]);
	});
});

describe("bookContentFrom", () => {
	it("builds BookContent, dropping text-less sections", () => {
		const content = bookContentFrom({ title: "My Book", author: "Ada" }, [
			{ title: "Cover", html: "<img src='c.png'/>" },
			{ title: "Ch 1", html: "<h1>Ch 1</h1><p>Text</p>" },
		]);
		expect(content.title).toBe("My Book");
		expect(content.author).toBe("Ada");
		expect(content.spine).toHaveLength(1);
		expect(content.spine[0]?.title).toBe("Ch 1");
	});

	it("names untitled sections by index", () => {
		const content = bookContentFrom({ title: "T", author: "" }, [{ title: "", html: "<p>One</p>" }]);
		expect(content.spine[0]?.title).toBe("Chapter 1");
	});

	// The positional fallback used to count SOURCE sections, so a book whose
	// cover/nav pages dropped out started at "Chapter 2" and skipped numbers.
	it("numbers the fallback by kept position, not source index", () => {
		const content = bookContentFrom({ title: "T", author: "" }, [
			{ title: "", html: "<img src='cover.png'/>" },
			{ title: "", html: "<p>One</p>" },
			{ title: "", html: "<p>Two</p>" },
		]);
		expect(content.spine.map((item) => item.title)).toEqual(["Chapter 1", "Chapter 2"]);
	});

	it("falls back to the section's own first heading before a positional name", () => {
		const content = bookContentFrom({ title: "T", author: "" }, [
			{ title: "", html: '<div class="title2">\u0413\u041b\u0410\u0412\u0410</div><p>Body</p>' },
		]);
		expect(content.spine[0]?.title).toBe("\u0413\u041b\u0410\u0412\u0410");
	});

	it("prefers the navigation label over the section's heading", () => {
		const content = bookContentFrom({ title: "T", author: "" }, [
			{ title: "From the NCX", html: "<h1>In the body</h1><p>Body</p>" },
		]);
		expect(content.spine[0]?.title).toBe("From the NCX");
	});

	it("keeps one spine item even when every section is empty", () => {
		const content = bookContentFrom({ title: "Empty", author: "" }, [{ title: "", html: "<img/>" }]);
		expect(content.spine).toHaveLength(1);
		expect(content.spine[0]?.blocks).toEqual([]);
	});
});
