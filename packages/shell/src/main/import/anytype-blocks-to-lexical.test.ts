/**
 * Anytype block tree → Lexical serialized state.
 */

import { describe, expect, it } from "vitest";
import { anytypeBlocksToLexical, anytypeDateToMs } from "./anytype-blocks-to-lexical";

function textBlock(
	id: string,
	text: string,
	style: string,
	extra?: { childrenIds?: string[]; checked?: boolean; marks?: unknown[] },
): Record<string, unknown> {
	return {
		id,
		childrenIds: extra?.childrenIds ?? [],
		text: {
			text,
			style,
			checked: extra?.checked ?? false,
			marks: { marks: extra?.marks ?? [] },
		},
	};
}

describe("anytypeDateToMs", () => {
	it("converts unix seconds to ms", () => {
		expect(anytypeDateToMs(1_700_000_000)).toBe(1_700_000_000_000);
	});
	it("passes through ms-scale values", () => {
		expect(anytypeDateToMs(1_700_000_000_000)).toBe(1_700_000_000_000);
	});
	it("returns null for missing/invalid", () => {
		expect(anytypeDateToMs(null)).toBeNull();
		expect(anytypeDateToMs(0)).toBeNull();
		expect(anytypeDateToMs("")).toBeNull();
	});
});

describe("anytypeBlocksToLexical", () => {
	const handlers = {
		onMention: () => {},
		onLinkBlock: () => {},
		onFileBlock: () => {},
	};

	it("emits heading, paragraph, lists, checkbox, quote, hr, image", () => {
		const byId = new Map<string, Record<string, unknown>>([
			["root", { id: "root", childrenIds: ["h", "p", "ul1", "ul2", "c", "q", "hr", "img"] }],
			["h", textBlock("h", "Title", "Header1")],
			[
				"p",
				textBlock("p", "Hello world", "Paragraph", {
					marks: [{ range: { from: 0, to: 5 }, type: "Bold", param: "" }],
				}),
			],
			["ul1", textBlock("ul1", "one", "Marked")],
			["ul2", textBlock("ul2", "two", "Marked")],
			["c", textBlock("c", "done", "Checkbox", { checked: true })],
			["q", textBlock("q", "quoted", "Quote")],
			["hr", { id: "hr", div: { style: "Line" }, childrenIds: [] }],
			[
				"img",
				{
					id: "img",
					file: {
						name: "pic.png",
						type: "Image",
						targetObjectId: "file-1",
					},
					childrenIds: [],
				},
			],
		]);
		const { state, snippet } = anytypeBlocksToLexical(
			byId,
			["h", "p", "ul1", "ul2", "c", "q", "hr", "img"],
			handlers,
		);
		const children = (state.root as { children: Array<Record<string, unknown>> }).children;
		const types = children.map((c) => c.type);
		expect(types).toEqual([
			"heading",
			"paragraph",
			"list",
			"list",
			"quote",
			"horizontalrule",
			"image-block",
		]);
		// Consecutive Marked items collapsed into one bullet list.
		const bullet = children.find((c) => c.type === "list" && c.listType === "bullet") as {
			children: unknown[];
		};
		expect(bullet.children).toHaveLength(2);
		const check = children.find((c) => c.type === "list" && c.listType === "check") as {
			children: Array<{ checked?: boolean }>;
		};
		expect(check.children[0]?.checked).toBe(true);
		const img = children.find((c) => c.type === "image-block") as { src: string; alt: string };
		expect(img.src).toBe("pic.png");
		expect(snippet).toContain("Title");
		expect(snippet).toContain("Hello world");
	});

	it("skips title/description chrome blocks", () => {
		const byId = new Map<string, Record<string, unknown>>([
			["title", textBlock("title", "Should skip", "Title")],
			["p", textBlock("p", "Keep me", "Paragraph")],
		]);
		const { state, snippet } = anytypeBlocksToLexical(byId, ["title", "p"], handlers);
		const children = (state.root as { children: Array<Record<string, unknown>> }).children;
		expect(children).toHaveLength(1);
		expect(children[0]?.type).toBe("paragraph");
		expect(snippet).toBe("Keep me");
	});

	it("emits link inlines for Link marks", () => {
		const byId = new Map<string, Record<string, unknown>>([
			[
				"p",
				textBlock("p", "see docs here", "Paragraph", {
					marks: [{ range: { from: 4, to: 8 }, type: "Link", param: "https://example.com" }],
				}),
			],
		]);
		const { state } = anytypeBlocksToLexical(byId, ["p"], handlers);
		const para = (state.root as { children: Array<Record<string, unknown>> }).children[0] as {
			children: Array<Record<string, unknown>>;
		};
		const link = para.children.find((c) => c.type === "link");
		expect(link?.url).toBe("https://example.com");
	});
});
