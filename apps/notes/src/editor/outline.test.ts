// @vitest-environment jsdom
import { createHeadlessEditor } from "@lexical/headless";
import { $createListItemNode, $createListNode, ListItemNode, ListNode } from "@lexical/list";
import { $createHeadingNode, $createQuoteNode, HeadingNode, QuoteNode } from "@lexical/rich-text";
import { $createParagraphNode, $createTextNode, $getRoot, type LexicalEditor } from "lexical";
import { describe, expect, it } from "vitest";
import {
	$collectOutline,
	type OutlineEntry,
	activeOutlineIndex,
	outlineBaseLevel,
	sameOutline,
} from "./outline";

function editor(): LexicalEditor {
	return createHeadlessEditor({
		namespace: "outline",
		nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode],
		onError: (e) => {
			throw e;
		},
	});
}

describe("$collectOutline", () => {
	it("lists headings in document order with their level, skipping body text", () => {
		const e = editor();
		e.update(
			() => {
				const root = $getRoot();
				root.append(
					$createHeadingNode("h1").append($createTextNode("Intro")),
					$createParagraphNode().append($createTextNode("body")),
					$createHeadingNode("h3").append($createTextNode("  Detail  ")),
					$createQuoteNode().append($createTextNode("not a heading")),
					$createHeadingNode("h2").append($createTextNode("")),
				);
			},
			{ discrete: true },
		);
		const out = e.getEditorState().read($collectOutline);
		expect(out.map((o) => [o.text, o.level])).toEqual([
			["Intro", 1],
			["Detail", 3],
			["", 2],
		]);
	});

	it("finds a heading nested inside a container block", () => {
		const e = editor();
		e.update(
			() => {
				const list = $createListNode("bullet");
				const item = $createListItemNode();
				list.append(item);
				item.append($createTextNode("x"));
				$getRoot().append(list, $createHeadingNode("h2").append($createTextNode("After")));
			},
			{ discrete: true },
		);
		expect(
			e
				.getEditorState()
				.read($collectOutline)
				.map((o) => o.text),
		).toEqual(["After"]);
	});
});

describe("outline helpers", () => {
	const a: OutlineEntry[] = [
		{ key: "1", text: "A", level: 2 },
		{ key: "2", text: "B", level: 3 },
	];

	it("sameOutline compares key, text and level", () => {
		expect(
			sameOutline(
				a,
				a.map((x) => ({ ...x })),
			),
		).toBe(true);
		expect(sameOutline(a, [a[0] as OutlineEntry])).toBe(false);
		expect(sameOutline(a, [a[0] as OutlineEntry, { key: "2", text: "B!", level: 3 }])).toBe(false);
	});

	it("outlineBaseLevel is the shallowest level present", () => {
		expect(outlineBaseLevel(a)).toBe(2);
		expect(outlineBaseLevel([])).toBe(1);
	});

	it("activeOutlineIndex picks the last heading at or above the threshold", () => {
		expect(activeOutlineIndex([], 0)).toBe(-1);
		expect(activeOutlineIndex([100, 300, 500], 50)).toBe(0);
		expect(activeOutlineIndex([-200, 40, 500], 50)).toBe(1);
		expect(activeOutlineIndex([-400, -200, -10], 50)).toBe(2);
		expect(activeOutlineIndex([-400, null, 600], 50)).toBe(0);
	});
});
