import { createHeadlessEditor } from "@lexical/headless";
import {
	$createParagraphNode,
	$createTextNode,
	$getNodeByKey,
	$getRoot,
	$isElementNode,
	type LexicalEditor,
	type LexicalNode,
} from "lexical";
import { describe, expect, it } from "vitest";
import { BlockEmbedNode } from "../nodes/block-embed-node";
import {
	$createTabPaneNode,
	$createTabsNode,
	$isTabPaneNode,
	$isTabsNode,
	TabPaneNode,
	TabsNode,
	normalizeTabTitle,
} from "../nodes/tabs-node";
import { serializedStateToHtml } from "../serialize-html";
import { serializedStateToMarkdown } from "../serialize-markdown";
import { applyEmbedInsertion } from "./embed-insert";
import { resolveActivePane } from "./tabs-active-store";
import {
	$addTab,
	$deleteTab,
	$insertTabs,
	$moveTab,
	$normalizeTabPane,
	$normalizeTabs,
	$renameTab,
	$selectionPane,
	$tabPanes,
} from "./tabs-ops";

function editor(): LexicalEditor {
	const e = createHeadlessEditor({
		namespace: "tabs",
		nodes: [TabsNode, TabPaneNode, BlockEmbedNode],
		onError: (err) => {
			throw err;
		},
	});
	e.registerNodeTransform(TabsNode, $normalizeTabs);
	e.registerNodeTransform(TabPaneNode, $normalizeTabPane);
	return e;
}

function shape(e: LexicalEditor): unknown {
	const walk = (n: LexicalNode): unknown => {
		if ($isTabPaneNode(n)) return { pane: n.getTitle(), children: n.getChildren().map(walk) };
		if ($isTabsNode(n)) return { tabs: n.getChildren().map(walk) };
		if ($isElementNode(n)) return n.getTextContent() || n.getType();
		return n.getType() === "text" ? n.getTextContent() : n.getType();
	};
	return e.getEditorState().read(() => $getRoot().getChildren().map(walk));
}

function seeded(text: string): LexicalEditor {
	const e = editor();
	e.update(
		() => {
			const p = $createParagraphNode();
			if (text) p.append($createTextNode(text));
			$getRoot().append(p);
			p.selectEnd();
		},
		{ discrete: true },
	);
	return e;
}

function tabsKey(e: LexicalEditor): string {
	return e.getEditorState().read(() => $getRoot().getFirstChildOrThrow().getKey());
}

function paneKeys(e: LexicalEditor): string[] {
	return e.getEditorState().read(() => {
		const tabs = $getRoot().getFirstChild();
		return $isTabsNode(tabs) ? $tabPanes(tabs).map((p) => p.getKey()) : [];
	});
}

describe("$insertTabs", () => {
	it("replaces an empty block with N titled panes, caret in the first", () => {
		const e = seeded("");
		e.update(() => void $insertTabs(["One", "Two"]), { discrete: true });
		expect(shape(e)).toEqual([
			{
				tabs: [
					{ pane: "One", children: ["paragraph"] },
					{ pane: "Two", children: ["paragraph"] },
				],
			},
		]);
		const at = e.getEditorState().read($selectionPane);
		expect(at?.paneKey).toBe(paneKeys(e)[0]);
	});

	it("moves a block with content into the first pane", () => {
		const e = seeded("hello");
		e.update(() => void $insertTabs(["A", "B"]), { discrete: true });
		expect(shape(e)).toEqual([
			{
				tabs: [
					{ pane: "A", children: ["hello"] },
					{ pane: "B", children: ["paragraph"] },
				],
			},
		]);
	});
});

describe("tab operations", () => {
	function twoTabs(): LexicalEditor {
		const e = seeded("");
		e.update(() => void $insertTabs(["A", "B"]), { discrete: true });
		return e;
	}

	it("adds, renames and reorders panes", () => {
		const e = twoTabs();
		e.update(() => void $addTab(tabsKey(e), "C"), { discrete: true });
		const [a, , c] = paneKeys(e);
		e.update(() => $renameTab(a as string, "  Alpha \n tab "), { discrete: true });
		e.update(() => $moveTab(c as string, -5), { discrete: true });
		expect((shape(e) as { tabs: { pane: string }[] }[])[0]?.tabs.map((p) => p.pane)).toEqual([
			"C",
			"Alpha tab",
			"B",
		]);
		e.update(() => $moveTab(c as string, 1), { discrete: true });
		expect((shape(e) as { tabs: { pane: string }[] }[])[0]?.tabs.map((p) => p.pane)).toEqual([
			"Alpha tab",
			"C",
			"B",
		]);
	});

	it("deleting a pane activates its neighbour; deleting the last removes the block", () => {
		const e = twoTabs();
		const [a, b] = paneKeys(e);
		let next: string | null = null;
		e.update(
			() => {
				next = $deleteTab(a as string);
			},
			{ discrete: true },
		);
		expect(next).toBe(b);
		e.update(() => void $deleteTab(b as string), { discrete: true });
		expect(shape(e)).toEqual(["paragraph"]);
	});

	it("normalizes: stray blocks join a pane, empty panes get a paragraph, orphan panes dissolve", () => {
		const e = editor();
		e.update(
			() => {
				const tabs = $createTabsNode();
				tabs.append($createParagraphNode().append($createTextNode("stray")));
				tabs.append($createTabPaneNode("Empty"));
				const orphan = $createTabPaneNode("Orphan");
				orphan.append($createParagraphNode().append($createTextNode("loose")));
				$getRoot().append(tabs, orphan);
			},
			{ discrete: true },
		);
		expect(shape(e)).toEqual([
			{
				tabs: [
					{ pane: "", children: ["stray"] },
					{ pane: "Empty", children: ["paragraph"] },
				],
			},
			"loose",
		]);
	});

	it("a pane holds an embedded database view block in place", () => {
		const e = twoTabs();
		const [, b] = paneKeys(e);
		const paragraphKey = e.getEditorState().read(() => {
			const pane = $getNodeByKey(b as string);
			return $isTabPaneNode(pane) ? (pane.getFirstChild()?.getKey() ?? null) : null;
		});
		applyEmbedInsertion(e, paragraphKey, {
			entityId: "view-1",
			entityType: "brainstorm/ListView/v1",
			label: "Tasks",
		});
		expect((shape(e) as { tabs: { pane: string; children: unknown[] }[] }[])[0]?.tabs[1]).toEqual({
			pane: "B",
			children: ["block-embed"],
		});
	});

	it("clamps and collapses titles", () => {
		expect(normalizeTabTitle("  a \t b ")).toBe("a b");
		expect(normalizeTabTitle("x".repeat(200))).toHaveLength(80);
		expect(normalizeTabTitle(42)).toBe("");
	});

	it("round-trips through JSON", () => {
		const e = twoTabs();
		const json = JSON.stringify(e.getEditorState().toJSON());
		const next = editor();
		next.setEditorState(next.parseEditorState(json));
		expect(shape(next)).toEqual(shape(e));
	});
});

describe("resolveActivePane", () => {
	it("keeps a remembered pane that still exists, else the first", () => {
		expect(resolveActivePane("b", ["a", "b"])).toBe("b");
		expect(resolveActivePane("gone", ["a", "b"])).toBe("a");
		expect(resolveActivePane(undefined, [])).toBeNull();
	});
});

describe("tabs export", () => {
	const state = {
		root: {
			children: [
				{
					type: "tabs",
					children: [
						{
							type: "tab-pane",
							title: "Overview",
							children: [{ type: "paragraph", children: [{ type: "text", text: "Intro" }] }],
						},
						{
							type: "tab-pane",
							title: "<Data>",
							children: [{ type: "block-embed", text: "Tasks view" }],
						},
					],
				},
			],
		},
	};

	it("renders every pane sequentially under its title in HTML (escaped)", () => {
		const html = serializedStateToHtml(state);
		expect(html).toBe(
			"<div><section><h3>Overview</h3><p>Intro</p></section><section><h3>&lt;Data&gt;</h3>Tasks view</section></div>",
		);
	});

	it("renders every pane sequentially under a heading in Markdown", () => {
		expect(serializedStateToMarkdown(state)).toBe(
			"### Overview\n\nIntro\n\n### <Data>\n\nTasks view",
		);
	});
});
