import { describe, expect, it } from "vitest";
import {
	type NotionBlock,
	type NotionRichText,
	notionBlockToMarkdown,
	notionBlocksToMarkdown,
	notionRichTextToMarkdown,
} from "./notion-api-blocks";
import { markdownToSerializedState } from "./plant-import-body";

function rt(plain: string, extra: Partial<NotionRichText> = {}): NotionRichText {
	return { plain_text: plain, ...extra };
}

/** A block whose type-specific payload holds `rich_text`. */
function textBlock(
	type: string,
	rich: NotionRichText[],
	extra: Record<string, unknown> = {},
): NotionBlock {
	return { type, [type]: { rich_text: rich, ...extra } };
}

function topLevelTypes(md: string): string[] {
	const state = markdownToSerializedState(md) as unknown as {
		root: { children: Array<{ type: string }> };
	};
	return state.root.children.map((c) => c.type);
}

describe("notionRichTextToMarkdown", () => {
	it("renders plain, bold, italic, and code with the strongest single mark", () => {
		expect(notionRichTextToMarkdown([rt("plain")])).toBe("plain");
		expect(notionRichTextToMarkdown([rt("b", { annotations: { bold: true } })])).toBe("**b**");
		expect(notionRichTextToMarkdown([rt("i", { annotations: { italic: true } })])).toBe("*i*");
		expect(notionRichTextToMarkdown([rt("c", { annotations: { code: true } })])).toBe("`c`");
	});

	it("code wins over bold/italic (single-pass importer can't nest marks)", () => {
		expect(
			notionRichTextToMarkdown([rt("x", { annotations: { code: true, bold: true, italic: true } })]),
		).toBe("`x`");
	});

	it("renders a link (and a link ignores other marks so no literal brackets leak)", () => {
		expect(
			notionRichTextToMarkdown([rt("site", { href: "https://x.dev", annotations: { bold: true } })]),
		).toBe("[site](https://x.dev)");
	});

	it("concatenates segments and skips empty ones", () => {
		expect(
			notionRichTextToMarkdown([rt("a"), rt(""), rt("b", { annotations: { bold: true } })]),
		).toBe("a**b**");
	});

	it("empty / undefined rich_text → empty string", () => {
		expect(notionRichTextToMarkdown([])).toBe("");
		expect(notionRichTextToMarkdown(undefined)).toBe("");
	});
});

describe("notionBlockToMarkdown", () => {
	it("maps headings to # / ## / ###", () => {
		expect(notionBlockToMarkdown(textBlock("heading_1", [rt("H1")]))).toBe("# H1");
		expect(notionBlockToMarkdown(textBlock("heading_2", [rt("H2")]))).toBe("## H2");
		expect(notionBlockToMarkdown(textBlock("heading_3", [rt("H3")]))).toBe("### H3");
	});

	it("maps list items and to-dos", () => {
		expect(notionBlockToMarkdown(textBlock("bulleted_list_item", [rt("b")]))).toBe("- b");
		expect(notionBlockToMarkdown(textBlock("numbered_list_item", [rt("n")]))).toBe("1. n");
		expect(notionBlockToMarkdown(textBlock("to_do", [rt("open")], { checked: false }))).toBe(
			"- [ ] open",
		);
		expect(notionBlockToMarkdown(textBlock("to_do", [rt("done")], { checked: true }))).toBe(
			"- [x] done",
		);
	});

	it("flattens callout to a quote, prefixing the icon emoji", () => {
		const block: NotionBlock = {
			type: "callout",
			callout: { rich_text: [rt("heads up")], icon: { emoji: "💡" } },
		};
		expect(notionBlockToMarkdown(block)).toBe("> 💡 heads up");
	});

	it("renders a code block with a language and joins rich_text verbatim", () => {
		const block: NotionBlock = {
			type: "code",
			code: { rich_text: [rt("const x = 1;")], language: "javascript" },
		};
		expect(notionBlockToMarkdown(block)).toBe("```javascript\nconst x = 1;\n```");
	});

	it("drops the fence language for Notion's 'plain text'", () => {
		const block: NotionBlock = {
			type: "code",
			code: { rich_text: [rt("hi")], language: "plain text" },
		};
		expect(notionBlockToMarkdown(block)).toBe("```\nhi\n```");
	});

	it("renders divider and image (external + file url, caption as alt)", () => {
		expect(notionBlockToMarkdown({ type: "divider", divider: {} })).toBe("---");
		expect(
			notionBlockToMarkdown({
				type: "image",
				image: { external: { url: "https://x.dev/a.png" }, caption: [rt("a cat")] },
			}),
		).toBe("![a cat](https://x.dev/a.png)");
		expect(
			notionBlockToMarkdown({ type: "image", image: { file: { url: "https://s3/f.png" } } }),
		).toBe("![image](https://s3/f.png)");
	});

	it("drops an unknown block with no text, keeps one that carries text", () => {
		expect(notionBlockToMarkdown({ type: "unsupported", unsupported: {} })).toBeNull();
		expect(notionBlockToMarkdown({ type: "mystery", mystery: { rich_text: [rt("kept")] } })).toBe(
			"kept",
		);
	});
});

describe("notionBlocksToMarkdown", () => {
	it("blank-separates blocks but groups adjacent list items", () => {
		const md = notionBlocksToMarkdown([
			textBlock("heading_1", [rt("Title")]),
			textBlock("paragraph", [rt("Intro")]),
			textBlock("bulleted_list_item", [rt("one")]),
			textBlock("bulleted_list_item", [rt("two")]),
			textBlock("paragraph", [rt("Outro")]),
		]);
		expect(md).toBe("# Title\n\nIntro\n\n- one\n- two\n\nOutro");
	});

	it("appends a block's children in reading order (flattened)", () => {
		const md = notionBlocksToMarkdown([
			{
				type: "toggle",
				toggle: { rich_text: [rt("Summary")] },
				children: [textBlock("paragraph", [rt("hidden detail")])],
			},
		]);
		expect(md).toBe("Summary\n\nhidden detail");
	});

	it("round-trips through the real importer parser into the right block nodes", () => {
		const md = notionBlocksToMarkdown([
			textBlock("heading_2", [rt("Section")]),
			textBlock("paragraph", [rt("body")]),
			textBlock("bulleted_list_item", [rt("a")]),
			textBlock("bulleted_list_item", [rt("b")]),
			textBlock("to_do", [rt("task")], { checked: true }),
			textBlock("quote", [rt("wisdom")]),
			{ type: "code", code: { rich_text: [rt("x")], language: "ts" } },
			{ type: "divider", divider: {} },
		]);
		// Proves the emitted dialect is exactly what markdownToSerializedState parses.
		expect(topLevelTypes(md)).toEqual([
			"heading",
			"paragraph",
			"list", // bullets grouped
			"list", // the to-do becomes a check list
			"quote",
			"code",
			"horizontalrule",
		]);
	});

	it("empty block list → empty string", () => {
		expect(notionBlocksToMarkdown([])).toBe("");
	});
});
