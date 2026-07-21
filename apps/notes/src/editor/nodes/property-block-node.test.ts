// @vitest-environment jsdom
import { PropertyView } from "@brainstorm-os/sdk-types";
import { CodeNode } from "@lexical/code";
import { createHeadlessEditor } from "@lexical/headless";
import { AutoLinkNode, LinkNode } from "@lexical/link";
import { ListItemNode, ListNode } from "@lexical/list";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { $getRoot, type LexicalEditor } from "lexical";
import { describe, expect, it } from "vitest";
import {
	$createPropertyBlockNode,
	$isPropertyBlockNode,
	PROPERTY_BLOCK_TYPE,
	PropertyBlockNode,
	type SerializedPropertyBlockNode,
} from "./property-block-node";

function createEditor(): LexicalEditor {
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
		],
		onError(error) {
			throw error;
		},
	});
}

describe("PropertyBlockNode", () => {
	it("creates with property key + null view (default)", () => {
		const editor = createEditor();
		let result = { key: "", view: null as PropertyView | null, blockId: "" };
		editor.update(
			() => {
				const node = $createPropertyBlockNode("prop_text_1");
				result = {
					key: node.getPropertyKey(),
					view: node.getView(),
					blockId: node.getBlockId(),
				};
			},
			{ discrete: true },
		);
		expect(result.key).toBe("prop_text_1");
		expect(result.view).toBeNull();
		expect(result.blockId).toMatch(/^pb_[0-9a-z]+_[0-9a-z]+$/);
	});

	it("creates with explicit view + persists view through getter", () => {
		const editor = createEditor();
		let view: PropertyView | null = null;
		editor.update(
			() => {
				const node = $createPropertyBlockNode("prop_num_1", PropertyView.Plain);
				view = node.getView();
			},
			{ discrete: true },
		);
		expect(view).toBe(PropertyView.Plain);
	});

	it("preserves an explicit blockId when one is provided (paste / restore)", () => {
		const editor = createEditor();
		let blockId = "";
		editor.update(
			() => {
				const node = $createPropertyBlockNode("prop_a", null, "pb_seeded_aaa");
				blockId = node.getBlockId();
			},
			{ discrete: true },
		);
		expect(blockId).toBe("pb_seeded_aaa");
	});

	it("$isPropertyBlockNode discriminates", () => {
		const editor = createEditor();
		let isProp = false;
		editor.update(
			() => {
				isProp = $isPropertyBlockNode($createPropertyBlockNode("prop_x"));
			},
			{ discrete: true },
		);
		expect(isProp).toBe(true);
		expect($isPropertyBlockNode(null)).toBe(false);
		expect($isPropertyBlockNode(undefined)).toBe(false);
	});

	it("round-trips through exportJSON → importJSON (with view)", () => {
		const editor = createEditor();
		let json: SerializedPropertyBlockNode | null = null;
		let restored: { key: string; view: PropertyView | null; blockId: string } | null = null;
		editor.update(
			() => {
				const original = $createPropertyBlockNode("prop_p", PropertyView.Plain, "pb_x_1");
				json = original.exportJSON();
				const back = PropertyBlockNode.importJSON(json);
				restored = {
					key: back.getPropertyKey(),
					view: back.getView(),
					blockId: back.getBlockId(),
				};
			},
			{ discrete: true },
		);
		const captured = json as ReturnType<PropertyBlockNode["exportJSON"]> | null;
		expect(captured?.type).toBe(PROPERTY_BLOCK_TYPE);
		expect(captured?.version).toBe(1);
		expect(captured?.view).toBe(PropertyView.Plain);
		expect(restored).toEqual({
			key: "prop_p",
			view: PropertyView.Plain,
			blockId: "pb_x_1",
		});
	});

	it("round-trips with view=null (kind-default rendering)", () => {
		const editor = createEditor();
		let restored: { view: PropertyView | null } | null = null;
		editor.update(
			() => {
				const original = $createPropertyBlockNode("prop_d");
				const json = original.exportJSON();
				const back = PropertyBlockNode.importJSON(json);
				restored = { view: back.getView() };
			},
			{ discrete: true },
		);
		const capturedRestored = restored as { view: PropertyView | null } | null;
		expect(capturedRestored?.view).toBeNull();
	});

	it("appends as a top-level block in an editor", () => {
		const editor = createEditor();
		editor.update(
			() => {
				const root = $getRoot();
				root.clear();
				root.append($createPropertyBlockNode("prop_top"));
			},
			{ discrete: true },
		);
		let foundType = "";
		editor.getEditorState().read(() => {
			const first = $getRoot().getFirstChild();
			foundType = first?.getType() ?? "";
		});
		expect(foundType).toBe(PROPERTY_BLOCK_TYPE);
	});

	it("preserves type + state across editor.toJSON → parseEditorState", () => {
		const editor = createEditor();
		editor.update(
			() => {
				const root = $getRoot();
				root.clear();
				root.append($createPropertyBlockNode("prop_snap", PropertyView.Pill, "pb_snap_1"));
			},
			{ discrete: true },
		);
		const snapshot = editor.getEditorState().toJSON();
		const otherEditor = createEditor();
		const state = otherEditor.parseEditorState(JSON.stringify(snapshot));
		otherEditor.setEditorState(state);
		let firstType = "";
		let firstKey = "";
		let firstView: PropertyView | null = null;
		let firstBlockId = "";
		otherEditor.getEditorState().read(() => {
			const first = $getRoot().getFirstChild();
			if ($isPropertyBlockNode(first)) {
				firstType = first.getType();
				firstKey = first.getPropertyKey();
				firstView = first.getView();
				firstBlockId = first.getBlockId();
			}
		});
		expect(firstType).toBe(PROPERTY_BLOCK_TYPE);
		expect(firstKey).toBe("prop_snap");
		expect(firstView).toBe(PropertyView.Pill);
		expect(firstBlockId).toBe("pb_snap_1");
	});

	it("clone copies all four fields without sharing __key", () => {
		const editor = createEditor();
		let same = { key: "", view: null as PropertyView | null, blockId: "" };
		let cloned = { key: "", view: null as PropertyView | null, blockId: "" };
		editor.update(
			() => {
				const original = $createPropertyBlockNode("prop_c", PropertyView.Plain, "pb_clone_1");
				const copy = PropertyBlockNode.clone(original);
				same = {
					key: original.getPropertyKey(),
					view: original.getView(),
					blockId: original.getBlockId(),
				};
				cloned = {
					key: copy.getPropertyKey(),
					view: copy.getView(),
					blockId: copy.getBlockId(),
				};
			},
			{ discrete: true },
		);
		expect(cloned).toEqual(same);
	});

	it("mutators write through Lexical's getWritable", () => {
		const editor = createEditor();
		let after = { key: "", view: null as PropertyView | null };
		editor.update(
			() => {
				const node = $createPropertyBlockNode("prop_initial");
				node.setPropertyKey("prop_mutated");
				node.setView(PropertyView.Pill);
				after = {
					key: node.getPropertyKey(),
					view: node.getView(),
				};
			},
			{ discrete: true },
		);
		expect(after).toEqual({ key: "prop_mutated", view: PropertyView.Pill });
	});

	it("decorate returns a JSX element", () => {
		const editor = createEditor();
		let isElement = false;
		editor.update(
			() => {
				const node = $createPropertyBlockNode("prop_decor");
				const out = node.decorate();
				// React elements are plain objects (with a $$typeof Symbol marker).
				// Coarse `typeof` check is sufficient — full render is exercised
				// in `property-block-decorator.test.tsx`.
				isElement = typeof out === "object" && out !== null;
			},
			{ discrete: true },
		);
		expect(isElement).toBe(true);
	});
});
