// @vitest-environment jsdom
import { type PropertyDef, PropertyFormat, ValueType } from "@brainstorm-os/sdk-types";
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
import { describe, expect, it } from "vitest";
import {
	applyAddPropertyAppendToList,
	applyAddPropertyInsertAfter,
	applyAddPropertyReplaceParagraph,
	filterProperties,
} from "./add-property-ops";
import {
	$createPropertyBlockNode,
	$isPropertyBlockNode,
	PropertyBlockNode,
} from "./nodes/property-block-node";
import {
	$createPropertyListBlockNode,
	$isPropertyListBlockNode,
	PropertyListBlockNode,
} from "./nodes/property-list-block-node";

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

function makeDef(key: string, name: string, valueType: ValueType = ValueType.Text): PropertyDef {
	return { key, name, icon: null, valueType };
}

describe("filterProperties — ranking", () => {
	const DEFS = [
		makeDef("p1", "Status"),
		makeDef("p2", "Start date"),
		makeDef("p3", "Tags"),
		makeDef("p4", "Last edited at"),
		makeDef("p5", "Owner"),
	];

	it("returns every def with rank 0 for an empty query (sorted alphabetically)", () => {
		const out = filterProperties(DEFS, "");
		// Empty query sorts results by name for predictable enumeration.
		expect(out.map((r) => r.def.name)).toEqual([
			"Last edited at",
			"Owner",
			"Start date",
			"Status",
			"Tags",
		]);
		expect(out.every((r) => r.rank === 0)).toBe(true);
	});

	it("ranks prefix matches above word-start above anywhere matches", () => {
		const out = filterProperties(DEFS, "st");
		const names = out.map((r) => r.def.name);
		// Prefix: "Status", "Start date" (lowercased both start with "st").
		// Word-start: "Last edited at" -> no, "edited at" doesn't start with "st".
		// Anywhere: none.
		expect(names.slice(0, 2).sort()).toEqual(["Start date", "Status"]);
	});

	it("matches a query in the middle of a name (anywhere rank)", () => {
		const out = filterProperties(DEFS, "ited");
		expect(out.map((r) => r.def.name)).toEqual(["Last edited at"]);
	});

	it("matches a word-start in a multi-word name", () => {
		const out = filterProperties(DEFS, "dat");
		// "Start date" — "date" starts the second word ⇒ word-start rank.
		expect(out.map((r) => r.def.name)).toEqual(["Start date"]);
	});

	it("filters out defs whose name doesn't contain the query at all", () => {
		const out = filterProperties(DEFS, "xyz");
		expect(out).toEqual([]);
	});

	it("is case-insensitive", () => {
		const lower = filterProperties(DEFS, "OWNER");
		const upper = filterProperties(DEFS, "owner");
		expect(lower.map((r) => r.def.name)).toEqual(upper.map((r) => r.def.name));
		expect(lower.map((r) => r.def.name)).toEqual(["Owner"]);
	});

	it("trims whitespace from the query", () => {
		const out = filterProperties(DEFS, "   status   ");
		expect(out.map((r) => r.def.name)).toEqual(["Status"]);
	});

	it("sorts ties by name (locale-compare)", () => {
		const defs = [makeDef("a", "Banana"), makeDef("b", "Apple"), makeDef("c", "Avocado")];
		const out = filterProperties(defs, "a");
		// All three contain "a" (case-insensitive). Apple + Avocado start with
		// "a" (prefix rank 0); Banana has it mid-word (anywhere rank 2).
		expect(out.map((r) => r.def.name)).toEqual(["Apple", "Avocado", "Banana"]);
	});
});

describe("applyAddPropertyReplaceParagraph", () => {
	it("replaces the targeted paragraph with a PropertyBlockNode", () => {
		const editor = makeEditor();
		let paragraphKey = "" as NodeKey;
		editor.update(
			() => {
				const root = $getRoot();
				root.clear();
				const p = $createParagraphNode();
				p.append($createTextNode("/property"));
				root.append(p);
				paragraphKey = p.getKey();
			},
			{ discrete: true },
		);

		applyAddPropertyReplaceParagraph(editor, paragraphKey, "prop_status");

		let firstType = "";
		let firstPropertyKey = "";
		let trailingType = "";
		editor.getEditorState().read(() => {
			const root = $getRoot();
			const first = root.getFirstChild();
			if ($isPropertyBlockNode(first)) {
				firstType = first.getType();
				firstPropertyKey = first.getPropertyKey();
			}
			trailingType = root.getLastChild()?.getType() ?? "";
		});
		expect(firstType).toBe("property-block");
		expect(firstPropertyKey).toBe("prop_status");
		expect(trailingType).toBe("paragraph");
	});

	it("is a no-op when the paragraph key has been removed (race)", () => {
		const editor = makeEditor();
		editor.update(
			() => {
				const root = $getRoot();
				root.clear();
				root.append($createParagraphNode());
			},
			{ discrete: true },
		);
		applyAddPropertyReplaceParagraph(editor, "stale-key", "prop_x");
		let firstType = "";
		editor.getEditorState().read(() => {
			firstType = $getRoot().getFirstChild()?.getType() ?? "";
		});
		expect(firstType).toBe("paragraph");
	});
});

describe("applyAddPropertyInsertAfter", () => {
	it("inserts a PropertyBlockNode after the targeted block", () => {
		const editor = makeEditor();
		let pKey = "" as NodeKey;
		editor.update(
			() => {
				const root = $getRoot();
				root.clear();
				const p = $createParagraphNode();
				p.append($createTextNode("after this"));
				root.append(p);
				pKey = p.getKey();
			},
			{ discrete: true },
		);
		applyAddPropertyInsertAfter(editor, pKey, "prop_tags");

		let secondType = "";
		let secondPropertyKey = "";
		editor.getEditorState().read(() => {
			const children = $getRoot().getChildren();
			const second = children[1];
			if (second && $isPropertyBlockNode(second)) {
				secondType = second.getType();
				secondPropertyKey = second.getPropertyKey();
			}
		});
		expect(secondType).toBe("property-block");
		expect(secondPropertyKey).toBe("prop_tags");
	});

	it("appends a fresh PropertyBlock + trailing paragraph when the target is missing", () => {
		const editor = makeEditor();
		editor.update(
			() => {
				const root = $getRoot();
				root.clear();
				root.append($createParagraphNode());
			},
			{ discrete: true },
		);
		applyAddPropertyInsertAfter(editor, "stale-key", "prop_owner");
		let kinds: string[] = [];
		editor.getEditorState().read(() => {
			kinds = $getRoot()
				.getChildren()
				.map((c) => c.getType());
		});
		// Targeted node didn't exist — fallback appends the property block at root.
		expect(kinds).toContain("property-block");
	});
});

describe("applyAddPropertyAppendToList", () => {
	it("appends the key to an existing PropertyListBlockNode", () => {
		const editor = makeEditor();
		let listKey = "" as NodeKey;
		editor.update(
			() => {
				const root = $getRoot();
				root.clear();
				const list = $createPropertyListBlockNode(["existing"]);
				root.append(list);
				listKey = list.getKey();
			},
			{ discrete: true },
		);
		applyAddPropertyAppendToList(editor, listKey, "new-key");

		let keys: readonly string[] = [];
		editor.getEditorState().read(() => {
			const node = $getRoot().getFirstChild();
			if ($isPropertyListBlockNode(node)) {
				keys = node.getPropertyKeys();
			}
		});
		expect(keys).toEqual(["existing", "new-key"]);
	});

	it("is idempotent on duplicate keys", () => {
		const editor = makeEditor();
		let listKey = "" as NodeKey;
		editor.update(
			() => {
				const root = $getRoot();
				root.clear();
				const list = $createPropertyListBlockNode(["existing"]);
				root.append(list);
				listKey = list.getKey();
			},
			{ discrete: true },
		);
		applyAddPropertyAppendToList(editor, listKey, "existing");

		let keys: readonly string[] = [];
		editor.getEditorState().read(() => {
			const node = $getRoot().getFirstChild();
			if ($isPropertyListBlockNode(node)) {
				keys = node.getPropertyKeys();
			}
		});
		expect(keys).toEqual(["existing"]);
	});

	it("no-ops when the target isn't a PropertyListBlockNode", () => {
		const editor = makeEditor();
		let propBlockKey = "" as NodeKey;
		editor.update(
			() => {
				const root = $getRoot();
				root.clear();
				const block = $createPropertyBlockNode("prop_single");
				root.append(block);
				propBlockKey = block.getKey();
			},
			{ discrete: true },
		);
		applyAddPropertyAppendToList(editor, propBlockKey, "another");
		let firstType = "";
		let firstPropertyKey = "";
		editor.getEditorState().read(() => {
			const first = $getRoot().getFirstChild();
			if ($isPropertyBlockNode(first)) {
				firstType = first.getType();
				firstPropertyKey = first.getPropertyKey();
			}
		});
		expect(firstType).toBe("property-block");
		expect(firstPropertyKey).toBe("prop_single");
	});
});
