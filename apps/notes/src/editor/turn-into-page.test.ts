// @vitest-environment jsdom
import { $createTitleNode, BASELINE_NODES } from "@brainstorm-os/editor";
import { createYDocResolver, isUniversalBodyEmpty } from "@brainstorm-os/react-yjs";
import { $createListItemNode, $createListNode } from "@lexical/list";
import {
	$createParagraphNode,
	$createTextNode,
	$getNodeByKey,
	$getRoot,
	$isElementNode,
	type LexicalEditor,
	type NodeKey,
	type SerializedEditorState,
	createEditor,
} from "lexical";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Doc } from "yjs";
import { plantSerializedStateIntoDoc } from "../store/migrate-body";
import { NOTES_ADDITIONAL_NODES } from "./notes-nodes";
import {
	PAGE_ENTITY_TYPE,
	replaceBlocksWithPageRef,
	snapshotBlocksAsPage,
	turnBlocksIntoPage,
} from "./turn-into-page";

function makeEditor(): LexicalEditor {
	return createEditor({
		nodes: [...BASELINE_NODES, ...NOTES_ADDITIONAL_NODES],
		onError(error) {
			throw error;
		},
	});
}

type Seeded = { title: NodeKey; a: NodeKey; b: NodeKey; c: NodeKey; item: NodeKey };

function seed(editor: LexicalEditor): Seeded {
	const keys = { title: "", a: "", b: "", c: "", item: "" };
	editor.update(
		() => {
			const title = $createTitleNode().append($createTextNode("Host"));
			const a = $createParagraphNode().append($createTextNode("Plan"));
			const b = $createParagraphNode().append($createTextNode("Step one"));
			const item = $createListItemNode().append($createTextNode("Bullet"));
			const list = $createListNode("bullet").append(item);
			const c = $createParagraphNode().append($createTextNode("After"));
			$getRoot().clear().append(title, a, b, list, c);
			Object.assign(keys, {
				title: title.getKey(),
				a: a.getKey(),
				b: b.getKey(),
				c: c.getKey(),
				item: item.getKey(),
			});
		},
		{ discrete: true },
	);
	return keys;
}

function rootTypes(editor: LexicalEditor): string[] {
	return editor.getEditorState().read(() =>
		$getRoot()
			.getChildren()
			.map((c) => c.getType()),
	);
}

function bodyTexts(state: SerializedEditorState): string[] {
	return (state.root.children as { type: string; children?: { text?: string }[] }[]).map(
		(c) => `${c.type}:${(c.children ?? []).map((x) => x.text ?? "").join("")}`,
	);
}

describe("snapshotBlocksAsPage", () => {
	it("titles the page from the first block and moves the rest into its body", () => {
		const editor = makeEditor();
		const k = seed(editor);
		const snap = snapshotBlocksAsPage(editor, new Set([k.b, k.a]));
		expect(snap?.title).toBe("Plan");
		expect(snap?.keys).toEqual([k.a, k.b]);
		if (!snap) return;
		expect(bodyTexts(snap.state)).toEqual(["title:Plan", "paragraph:Step one"]);
	});

	it("keeps a list item inside a list in the new body", () => {
		const editor = makeEditor();
		const k = seed(editor);
		const snap = snapshotBlocksAsPage(editor, new Set([k.item]));
		expect(snap?.title).toBe("Bullet");
		if (!snap) return;
		expect(bodyTexts(snap.state)[1]?.startsWith("list:")).toBe(true);
	});

	it("refuses a selection that contains the page title", () => {
		const editor = makeEditor();
		const k = seed(editor);
		expect(snapshotBlocksAsPage(editor, new Set([k.title, k.a]))).toBeNull();
		expect(snapshotBlocksAsPage(editor, new Set())).toBeNull();
	});
});

describe("replaceBlocksWithPageRef", () => {
	it("swaps the blocks for one page link in a single update", () => {
		const editor = makeEditor();
		const k = seed(editor);
		const snap = snapshotBlocksAsPage(editor, new Set([k.a, k.b]));
		if (!snap) throw new Error("no snapshot");
		const updates = vi.fn();
		const off = editor.registerUpdateListener(updates);
		expect(replaceBlocksWithPageRef(editor, snap, "n_page")).toBe(true);
		off();
		expect(updates).toHaveBeenCalledTimes(1);
		expect(rootTypes(editor)).toEqual(["title", "page-ref", "list", "paragraph"]);
	});

	it("drops an emptied list and lands the link where the item was", () => {
		const editor = makeEditor();
		const k = seed(editor);
		const snap = snapshotBlocksAsPage(editor, new Set([k.item]));
		if (!snap) throw new Error("no snapshot");
		replaceBlocksWithPageRef(editor, snap, "n_page");
		expect(rootTypes(editor)).toEqual(["title", "paragraph", "paragraph", "page-ref", "paragraph"]);
	});

	it("leaves the document alone when the blocks changed after the snapshot", () => {
		const editor = makeEditor();
		const k = seed(editor);
		const snap = snapshotBlocksAsPage(editor, new Set([k.a]));
		if (!snap) throw new Error("no snapshot");
		editor.update(
			() => {
				const block = $getNodeByKey(k.a);
				if ($isElementNode(block)) block.append($createTextNode(" edited"));
			},
			{ discrete: true },
		);
		expect(replaceBlocksWithPageRef(editor, snap, "n_page")).toBe(false);
	});
});

describe("turnBlocksIntoPage", () => {
	let resolver: ReturnType<typeof createYDocResolver>;
	let docs: Map<string, Doc>;

	beforeEach(() => {
		resolver = createYDocResolver({ load: async () => null, persist: () => {}, release: () => {} });
		docs = new Map();
	});
	afterEach(() => resolver.dispose());

	function deps(create = vi.fn(async () => ({}))) {
		return {
			create,
			resolve: (id: string) => {
				const handle = resolver.resolve(id);
				docs.set(id, handle.doc);
				return handle;
			},
			whenLoaded: resolver.whenLoaded,
			plant: plantSerializedStateIntoDoc,
			newId: () => "n_new",
			now: () => 42,
		};
	}

	it("creates the note, plants the blocks into its doc, then links it in place", async () => {
		const editor = makeEditor();
		const k = seed(editor);
		const d = deps();
		const id = await turnBlocksIntoPage(editor, new Set([k.a, k.b]), d);
		expect(id).toBe("n_new");
		expect(d.create).toHaveBeenCalledWith(
			PAGE_ENTITY_TYPE,
			{ title: "Plan", createdAt: 42, updatedAt: 42 },
			"n_new",
		);
		const doc = docs.get("n_new");
		expect(doc && isUniversalBodyEmpty(doc)).toBe(false);
		expect(rootTypes(editor)).toEqual(["title", "page-ref", "list", "paragraph"]);
	});

	it("changes nothing when the create fails", async () => {
		const editor = makeEditor();
		const k = seed(editor);
		const before = rootTypes(editor);
		await expect(
			turnBlocksIntoPage(
				editor,
				new Set([k.a]),
				deps(vi.fn(async () => Promise.reject(new Error("no")))),
			),
		).rejects.toThrow("no");
		expect(rootTypes(editor)).toEqual(before);
	});
});

describe("turn into page — undo", () => {
	it("one Yjs undo step brings the blocks back and drops the link", async () => {
		const { createBinding, createUndoManager, syncLexicalUpdateToYjs } = await import("@lexical/yjs");
		const { createLocalProvider } = await import("@brainstorm-os/editor");
		const { Doc: YDoc } = await import("yjs");
		const doc = new YDoc();
		const editor = makeEditor();
		const provider = createLocalProvider(doc);
		const binding = createBinding(editor, provider, "t", doc, new Map([["t", doc]]));
		editor.registerUpdateListener(
			({ prevEditorState, editorState, dirtyElements, dirtyLeaves, normalizedNodes, tags }) =>
				syncLexicalUpdateToYjs(
					binding,
					provider,
					prevEditorState,
					editorState,
					dirtyElements,
					dirtyLeaves,
					normalizedNodes,
					tags,
				),
		);
		const undo = createUndoManager(binding, binding.root.getSharedType());
		const k = seed(editor);
		undo.stopCapturing();
		const before = JSON.stringify(binding.root.getSharedType().toDelta());
		const snap = snapshotBlocksAsPage(editor, new Set([k.a, k.b]));
		if (!snap) throw new Error("no snapshot");
		expect(replaceBlocksWithPageRef(editor, snap, "n_page")).toBe(true);
		expect(JSON.stringify(binding.root.getSharedType().toDelta())).not.toBe(before);
		undo.undo();
		expect(JSON.stringify(binding.root.getSharedType().toDelta())).toBe(before);
		expect(undo.undoStack.length).toBe(1);
	});
});
