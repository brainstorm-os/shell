// @vitest-environment jsdom
/**
 * Wires-up tests for the `/property` slash command and the gutter
 * "Add property" block-action: both should leave the
 * `addPropertyStore` carrying a target of the right kind so the
 * AddPropertyMenu plugin can render against it.
 *
 * The pure-logic mutation paths are covered in `add-property-ops.test.ts`;
 * here we only verify the command-registry plumbing.
 */

import { createMapBlockAnchorStore, mountBlockAnchors } from "@brainstorm-os/editor";
import { CodeNode } from "@lexical/code";
import { createHeadlessEditor } from "@lexical/headless";
import { AutoLinkNode, LinkNode } from "@lexical/link";
import { ListItemNode, ListNode } from "@lexical/list";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	type LexicalEditor,
	type NodeKey,
} from "lexical";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddPropertyTargetKind, addPropertyStore } from "./add-property-store";
import { BLOCK_ACTIONS, BLOCK_COMMANDS, CommandCategory } from "./commands";
import { PropertyBlockNode } from "./nodes/property-block-node";
import { PropertyListBlockNode } from "./nodes/property-list-block-node";

function makeEditor(): LexicalEditor {
	return createHeadlessEditor({
		nodes: [
			HeadingNode,
			QuoteNode,
			ListNode,
			ListItemNode,
			CodeNode,
			LinkNode,
			AutoLinkNode,
			PropertyBlockNode,
			PropertyListBlockNode,
		],
		onError(err) {
			throw err;
		},
	});
}

beforeEach(() => {
	addPropertyStore.close();
});
afterEach(() => {
	addPropertyStore.close();
});

function stubGetElementByKey(editor: LexicalEditor): void {
	// Headless editors don't have a real DOM; the slash command resolves
	// an anchor via `editor.getElementByKey(...)`. Stub it to a fake
	// element with a minimal rect so the path runs to completion.
	const fake = {
		getBoundingClientRect(): DOMRect {
			return {
				top: 100,
				bottom: 120,
				left: 50,
				right: 200,
				width: 150,
				height: 20,
				x: 50,
				y: 100,
				toJSON: () => ({}),
			} as DOMRect;
		},
	} as HTMLElement;
	(editor as unknown as { getElementByKey: () => HTMLElement | null }).getElementByKey = () => fake;
}

describe("/property slash command (block.property.add)", () => {
	const slash = BLOCK_COMMANDS.find((c) => c.id === "block.property.add");

	it("is registered with CommandCategory.Property", () => {
		expect(slash).toBeDefined();
		expect(slash?.category).toBe(CommandCategory.Property);
	});

	it("opens the AddPropertyStore with a ReplaceParagraph target", () => {
		expect(slash).toBeDefined();
		const editor = makeEditor();
		stubGetElementByKey(editor);

		let paragraphKey = "" as NodeKey;
		editor.update(
			() => {
				const root = $getRoot();
				root.clear();
				const p = $createParagraphNode();
				p.append($createTextNode(""));
				root.append(p);
				p.selectStart();
				paragraphKey = p.getKey();
			},
			{ discrete: true },
		);

		slash?.run({ editor });

		const target = addPropertyStore.getSnapshot();
		expect(target?.kind).toBe(AddPropertyTargetKind.ReplaceParagraph);
		if (target?.kind === AddPropertyTargetKind.ReplaceParagraph) {
			expect(target.paragraphKey).toBe(paragraphKey);
		}
	});
});

describe("Block action 'Add property' (block.action.addProperty)", () => {
	const action = BLOCK_ACTIONS.find((c) => c.id === "block.action.addProperty");

	it("is registered with CommandCategory.Property", () => {
		expect(action).toBeDefined();
		expect(action?.category).toBe(CommandCategory.Property);
	});

	it("opens the store with an InsertAfter target seeded from blockKeys", () => {
		expect(action).toBeDefined();
		const editor = makeEditor();
		stubGetElementByKey(editor);

		let blockKey = "" as NodeKey;
		editor.update(
			() => {
				const root = $getRoot();
				root.clear();
				const p = $createParagraphNode();
				p.append($createTextNode("anchor"));
				root.append(p);
				blockKey = p.getKey();
			},
			{ discrete: true },
		);

		action?.run({ editor, blockKeys: new Set([blockKey]) });

		const target = addPropertyStore.getSnapshot();
		expect(target?.kind).toBe(AddPropertyTargetKind.InsertAfter);
		if (target?.kind === AddPropertyTargetKind.InsertAfter) {
			expect(target.blockKey).toBe(blockKey);
		}
	});

	it("is a no-op when blockKeys is empty (no anchor block to attach to)", () => {
		expect(action).toBeDefined();
		const editor = makeEditor();
		stubGetElementByKey(editor);
		action?.run({ editor, blockKeys: new Set<NodeKey>() });
		expect(addPropertyStore.getSnapshot()).toBeNull();
	});
});

describe("Block action 'Copy link to block' (block.action.copyLink)", () => {
	const action = BLOCK_ACTIONS.find((c) => c.id === "block.action.copyLink");
	const writes: string[] = [];

	beforeEach(() => {
		writes.length = 0;
		vi.stubGlobal("navigator", {
			clipboard: {
				writeText: (text: string) => {
					writes.push(text);
					return Promise.resolve();
				},
			},
		});
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("is registered with CommandCategory.Action", () => {
		expect(action).toBeDefined();
		expect(action?.category).toBe(CommandCategory.Action);
	});

	it("mints a DURABLE anchor id when the BlockAnchorsPlugin is mounted (B11.13)", async () => {
		expect(action).toBeDefined();
		const editor = makeEditor();
		const map = new Map<string, unknown>();
		const dispose = mountBlockAnchors(editor, createMapBlockAnchorStore(map));

		let blockKey = "" as NodeKey;
		editor.update(
			() => {
				const root = $getRoot();
				root.clear();
				const p = $createParagraphNode();
				p.append($createTextNode("durable anchor target"));
				root.append(p);
				blockKey = p.getKey();
			},
			{ discrete: true },
		);

		action?.run({ editor, blockKeys: new Set([blockKey]), documentId: "note-42" });
		await Promise.resolve();
		dispose();

		expect(writes).toHaveLength(1);
		const written = writes[0] ?? "";
		const anchorId = written.replace("brainstorm://entity/note-42#block-", "");
		expect(anchorId).not.toBe("");
		// Durable id, not the session NodeKey — and its fingerprint persisted.
		expect(anchorId).not.toBe(blockKey);
		expect(map.get(anchorId)).toMatchObject({ text: "durable anchor target" });
	});

	it("falls back to the session block key without the anchors plugin", async () => {
		expect(action).toBeDefined();
		const editor = makeEditor();

		let blockKey = "" as NodeKey;
		editor.update(
			() => {
				const root = $getRoot();
				root.clear();
				const p = $createParagraphNode();
				p.append($createTextNode("anchor"));
				root.append(p);
				blockKey = p.getKey();
			},
			{ discrete: true },
		);

		action?.run({ editor, blockKeys: new Set([blockKey]), documentId: "note-42" });
		await Promise.resolve();

		expect(writes).toEqual([`brainstorm://entity/note-42#block-${blockKey}`]);
	});

	it("is inert without a documentId (no open entity to link to)", async () => {
		expect(action).toBeDefined();
		const editor = makeEditor();
		action?.run({ editor, blockKeys: new Set(["k1" as NodeKey]) });
		await Promise.resolve();
		expect(writes).toEqual([]);
	});

	it("is inert when blockKeys is empty", async () => {
		expect(action).toBeDefined();
		const editor = makeEditor();
		action?.run({ editor, blockKeys: new Set<NodeKey>(), documentId: "note-42" });
		await Promise.resolve();
		expect(writes).toEqual([]);
	});
});

describe("addPropertyStore lifecycle", () => {
	it("subscribes / unsubscribes correctly and emits on open/close", () => {
		let count = 0;
		const unsubscribe = addPropertyStore.subscribe(() => {
			count += 1;
		});
		addPropertyStore.open({
			kind: AddPropertyTargetKind.AppendToList,
			listKey: "list-key" as NodeKey,
			anchor: new DOMRect(0, 0, 100, 100),
		});
		expect(count).toBe(1);
		addPropertyStore.close();
		expect(count).toBe(2);
		// Idempotent close: no extra emission.
		addPropertyStore.close();
		expect(count).toBe(2);

		unsubscribe();
		addPropertyStore.open({
			kind: AddPropertyTargetKind.AppendToList,
			listKey: "list-key-2" as NodeKey,
			anchor: new DOMRect(0, 0, 100, 100),
		});
		expect(count).toBe(2);
	});
});
