import { describe, expect, it } from "vitest";
import type { SerializedEditorStateLike } from "./preview";
import { serializedStateToMarkdown } from "./serialize-markdown";

function doc(children: unknown[]): SerializedEditorStateLike {
	return { root: { type: "root", children } } as SerializedEditorStateLike;
}
const text = (t: string, format = 0) => ({ type: "text", text: t, format });
const para = (...children: unknown[]) => ({ type: "paragraph", children });

describe("serializedStateToMarkdown", () => {
	it("returns '' for empty / malformed input", () => {
		expect(serializedStateToMarkdown(null)).toBe("");
		expect(serializedStateToMarkdown({} as never)).toBe("");
		expect(serializedStateToMarkdown("{nope")).toBe("");
	});

	it("renders headings at their level and paragraphs", () => {
		expect(
			serializedStateToMarkdown(
				doc([
					{ type: "heading", tag: "h1", children: [text("Title")] },
					para(text("body")),
					{ type: "heading", tag: "h3", children: [text("Sub")] },
				]),
			),
		).toBe("# Title\n\nbody\n\n### Sub");
	});

	it("renders emphasis markers inner-out (bold/italic/strike/code)", () => {
		expect(serializedStateToMarkdown(doc([para(text("x", 1))]))).toBe("**x**"); // bold
		expect(serializedStateToMarkdown(doc([para(text("x", 3))]))).toBe("***x***"); // bold+italic
		expect(serializedStateToMarkdown(doc([para(text("x", 4))]))).toBe("~~x~~"); // strike
		expect(serializedStateToMarkdown(doc([para(text("x", 16))]))).toBe("`x`"); // code
	});

	it("renders bullet and numbered lists", () => {
		const items = (type: string) => ({
			type: "list",
			listType: type,
			children: [
				{ type: "listitem", children: [text("one")] },
				{ type: "listitem", children: [text("two")] },
			],
		});
		expect(serializedStateToMarkdown(doc([items("bullet")]))).toBe("- one\n- two");
		expect(serializedStateToMarkdown(doc([items("number")]))).toBe("1. one\n2. two");
	});

	it("renders a horizontal rule as ---", () => {
		expect(
			serializedStateToMarkdown(doc([para(text("a")), { type: "horizontalrule" }, para(text("b"))])),
		).toBe("a\n\n---\n\nb");
	});

	it("renders links and images", () => {
		expect(
			serializedStateToMarkdown(
				doc([para({ type: "link", url: "https://x.com", children: [text("site")] })]),
			),
		).toBe("[site](https://x.com)");
		expect(serializedStateToMarkdown(doc([{ type: "image", src: "p.png", altText: "alt" }]))).toBe(
			"![alt](p.png)",
		);
	});

	it("fences a code block with its language", () => {
		expect(
			serializedStateToMarkdown(
				doc([{ type: "code", language: "ts", children: [text("const x=1")] }]),
			),
		).toBe("```ts\nconst x=1\n```");
	});

	it("renders a blockquote and a hard linebreak", () => {
		expect(serializedStateToMarkdown(doc([{ type: "quote", children: [text("q")] }]))).toBe("> q");
		expect(serializedStateToMarkdown(doc([para(text("a"), { type: "linebreak" }, text("b"))]))).toBe(
			"a  \nb",
		);
	});

	it("falls back to a decorator node's plain text", () => {
		expect(serializedStateToMarkdown(doc([para({ type: "mention", text: "@Alice" })]))).toBe(
			"@Alice",
		);
	});

	it("respects maxBlocks and drops empty blocks", () => {
		const many = doc([para(text("1")), para(text("2")), para(text("3"))]);
		expect(serializedStateToMarkdown(many, { maxBlocks: 2 })).toBe("1\n\n2");
		expect(serializedStateToMarkdown(doc([para(), para(text("x"))]))).toBe("x"); // empty para dropped
	});

	it("exports a bookmark or web embed as its plain URL, never an embed endpoint", () => {
		expect(
			serializedStateToMarkdown(
				doc([
					{
						type: "web-embed",
						url: "https://youtu.be/dQw4w9WgXcQ",
						embedUrl: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
						kind: "youtube",
					},
					{ type: "bookmark", url: "https://example.com/a", title: "T", description: "" },
					{ type: "web-embed", url: "javascript:alert(1)", embedUrl: null, kind: "bookmark" },
				]),
			),
		).toBe("https://youtu.be/dQw4w9WgXcQ\n\nhttps://example.com/a");
	});
});
