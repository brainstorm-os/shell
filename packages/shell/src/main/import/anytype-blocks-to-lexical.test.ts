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

	it("a numbered run split across layout-Div wrappers stays ONE list (F-443)", () => {
		const byId = new Map<string, Record<string, unknown>>([
			["root", { id: "root", childrenIds: ["w1", "w2", "w3"] }],
			["w1", { id: "w1", layout: { style: "Div" }, childrenIds: ["n1", "n2"] }],
			["w2", { id: "w2", layout: { style: "Div" }, childrenIds: ["n3"] }],
			["w3", { id: "w3", layout: { style: "Div" }, childrenIds: ["n4"] }],
			["n1", textBlock("n1", "einen Termin haben", "Numbered")],
			["n2", textBlock("n2", "einen Termin frei", "Numbered")],
			["n3", textBlock("n3", "bitte heute kommen", "Numbered")],
			["n4", textBlock("n4", "ist dringend", "Numbered")],
		]);
		const { state } = anytypeBlocksToLexical(byId, ["w1", "w2", "w3"], handlers);
		const children = (state.root as { children: Array<Record<string, unknown>> }).children;
		const lists = children.filter((c) => c.type === "list");
		expect(lists).toHaveLength(1);
		expect((lists[0]?.children as unknown[]).length).toBe(4);
	});

	it("Row/Column layouts keep their own numbering scope (client parity)", () => {
		const byId = new Map<string, Record<string, unknown>>([
			["root", { id: "root", childrenIds: ["row"] }],
			["row", { id: "row", layout: { style: "Row" }, childrenIds: ["colA", "colB"] }],
			["colA", { id: "colA", layout: { style: "Column" }, childrenIds: ["a1"] }],
			["colB", { id: "colB", layout: { style: "Column" }, childrenIds: ["b1"] }],
			["a1", textBlock("a1", "left one", "Numbered")],
			["b1", textBlock("b1", "right one", "Numbered")],
		]);
		const { state } = anytypeBlocksToLexical(byId, ["row"], handlers);
		const children = (state.root as { children: Array<Record<string, unknown>> }).children;
		const lists = children.filter((c) => c.type === "list");
		// Two separate single-item lists — each column restarts at 1, as the
		// Anytype client does.
		expect(lists).toHaveLength(2);
	});

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
