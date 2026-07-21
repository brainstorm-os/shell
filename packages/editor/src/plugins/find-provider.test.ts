// Pure model ops only (no DOM) → default node env; no jsdom pragma.
import { DEFAULT_FIND_OPTIONS, type FindQuery } from "@brainstorm-os/sdk/find-replace";
import { createHeadlessEditor } from "@lexical/headless";
import {
	$createParagraphNode,
	$createRangeSelection,
	$createTextNode,
	$getRoot,
	$getSelection,
	$isElementNode,
	$isRangeSelection,
	$isTextNode,
	$setSelection,
	type ElementNode,
	type LexicalEditor,
	type TextNode,
} from "lexical";
import { beforeEach, describe, expect, it } from "vitest";
import { type LexicalMatch, createLexicalSearchProvider } from "./find-provider";

function editorWith(paragraphs: string[]): LexicalEditor {
	const editor = createHeadlessEditor({
		namespace: "find-test",
		nodes: [],
		onError: (e) => {
			throw e;
		},
	});
	editor.update(
		() => {
			const root = $getRoot();
			for (const text of paragraphs) {
				const p = $createParagraphNode();
				p.append($createTextNode(text));
				root.append(p);
			}
		},
		{ discrete: true },
	);
	return editor;
}

const q = (term: string, over: Partial<FindQuery["options"]> = {}): FindQuery => ({
	term,
	options: { ...DEFAULT_FIND_OPTIONS, ...over },
});

const text = (editor: LexicalEditor): string =>
	editor.getEditorState().read(() => $getRoot().getTextContent());

describe("createLexicalSearchProvider — search (over the model)", () => {
	it("finds every occurrence with node-addressed offsets", () => {
		const p = createLexicalSearchProvider(editorWith(["the cat sat the cat mat"]));
		const m = p.search(q("cat")) as LexicalMatch[];
		expect(m).toHaveLength(2);
		expect(m[0]).toMatchObject({ start: 4, end: 7 });
		expect(m[1]).toMatchObject({ start: 16, end: 19 });
		expect(typeof m[0]?.nodeKey).toBe("string");
	});

	it("spans multiple text nodes / blocks in document order", () => {
		const m = createLexicalSearchProvider(editorWith(["x here", "and x there"])).search(q("x"));
		expect(m).toHaveLength(2);
		expect((m[0] as LexicalMatch).nodeKey).not.toBe((m[1] as LexicalMatch).nodeKey);
	});

	it("honours case-sensitive and whole-word options", () => {
		const p = createLexicalSearchProvider(editorWith(["Cat cat CAT category"]));
		// Case-insensitive substring → Cat, cat, CAT, and cat·egory.
		expect(p.search(q("cat"))).toHaveLength(4);
		// Literal "cat": the standalone word + inside "cat·egory".
		expect(p.search(q("cat", { caseSensitive: true }))).toHaveLength(2);
		// Whole-word still case-insensitive: Cat/cat/CAT, not 'category'.
		expect(p.search(q("cat", { wholeWord: true }))).toHaveLength(3);
		expect(p.search(q(""))).toEqual([]);
	});
});

describe("createLexicalSearchProvider — replace (via Lexical, one undo step)", () => {
	let editor: LexicalEditor;
	beforeEach(() => {
		editor = editorWith(["x x x"]);
	});

	it("replaceMatch splices exactly the one match", () => {
		const p = createLexicalSearchProvider(editor);
		const m = p.search(q("x")) as LexicalMatch[];
		p.replaceMatch(m[1] as LexicalMatch, "Y");
		expect(text(editor)).toBe("x Y x");
		expect(p.search(q("x"))).toHaveLength(2);
	});

	it("replaceAll replaces every match in one update and returns the count", () => {
		const p = createLexicalSearchProvider(editor);
		expect(p.replaceAll(q("x"), "ab")).toBe(3);
		expect(text(editor)).toBe("ab ab ab");
		expect(p.search(q("x"))).toHaveLength(0);
	});

	it("replaceAll right-to-left keeps offsets valid even when the replacement is longer/shorter", () => {
		const e = editorWith(["aa-aa-aa"]);
		const p = createLexicalSearchProvider(e);
		expect(p.replaceAll(q("aa"), "z")).toBe(3);
		expect(text(e)).toBe("z-z-z");
		// One `editor.update()` ⇒ one Lexical/Yjs transaction ⇒ one undo
		// step (doc 59); correctness of the batched splice is asserted by
		// the full-document result above.
	});
});

describe("createLexicalSearchProvider — revealMatch sets the MODEL selection", () => {
	it("selects the matched range (not a DOM range)", () => {
		const editor = editorWith(["alpha beta alpha"]);
		const p = createLexicalSearchProvider(editor);
		const m = p.search(q("beta")) as LexicalMatch[];
		p.revealMatch(m[0] as LexicalMatch);
		editor.getEditorState().read(() => {
			const sel = $getSelection();
			expect($isRangeSelection(sel)).toBe(true);
			if ($isRangeSelection(sel)) {
				expect(sel.anchor.offset).toBe(6);
				expect(sel.focus.offset).toBe(10);
			}
		});
	});

	it("selectionRange is null with no / collapsed selection", () => {
		expect(createLexicalSearchProvider(editorWith(["x"])).selectionRange).toBeNull();
	});
});

/** Set a ranged model selection over the ordered text nodes:
 *  textNode[startIdx]@startOff .. textNode[endIdx]@endOff. */
function selectRange(
	editor: LexicalEditor,
	startIdx: number,
	startOff: number,
	endIdx: number,
	endOff: number,
): void {
	editor.update(
		() => {
			const nodes: TextNode[] = [];
			const walk = (n: ElementNode) => {
				for (const c of n.getChildren()) {
					if ($isTextNode(c)) nodes.push(c);
					else if ($isElementNode(c)) walk(c);
				}
			};
			walk($getRoot());
			const sel = $createRangeSelection();
			sel.anchor.set((nodes[startIdx] as TextNode).getKey(), startOff, "text");
			sel.focus.set((nodes[endIdx] as TextNode).getKey(), endOff, "text");
			$setSelection(sel);
		},
		{ discrete: true },
	);
}

describe("inSelection scope (B9.2)", () => {
	const inSel = (term: string): FindQuery => q(term, { inSelection: true });

	it("restricts matches to a single-node ranged selection", () => {
		const editor = editorWith(["aaa bbb aaa"]); // matches at [0,3) and [8,11)
		const p = createLexicalSearchProvider(editor);
		expect(p.search(inSel("aaa"))).toHaveLength(2); // no selection → whole-doc no-op
		selectRange(editor, 0, 4, 0, 11); // cover "bbb aaa"
		const m = p.search(inSel("aaa")) as LexicalMatch[];
		expect(m).toHaveLength(1);
		expect(m[0]).toMatchObject({ start: 8, end: 11 });
		// Plain (non-inSelection) search is unaffected by the selection.
		expect(p.search(q("aaa"))).toHaveLength(2);
	});

	it("spans multiple nodes and excludes those outside the range", () => {
		const editor = editorWith(["aaa", "aaa", "aaa"]); // one match per node
		const p = createLexicalSearchProvider(editor);
		selectRange(editor, 0, 0, 1, 3); // node0 fully + node1 fully, not node2
		const m = p.search(inSel("aaa")) as LexicalMatch[];
		expect(m).toHaveLength(2);
	});

	it("is a no-op (whole-doc) with a collapsed selection", () => {
		const editor = editorWith(["aaa aaa"]);
		const p = createLexicalSearchProvider(editor);
		selectRange(editor, 0, 2, 0, 2); // collapsed
		expect(p.search(inSel("aaa"))).toHaveLength(2);
		expect(p.selectionRange).toBeNull();
	});

	it("exposes a non-null selectionRange for a real ranged selection", () => {
		const editor = editorWith(["alpha beta"]);
		const p = createLexicalSearchProvider(editor);
		selectRange(editor, 0, 0, 0, 5);
		expect(p.selectionRange).not.toBeNull();
	});
});

describe("seedTerm (OQ-FR-4 — prefill from selection)", () => {
	it("returns the selected substring within a single text node", () => {
		const editor = editorWith(["alpha beta gamma"]);
		const p = createLexicalSearchProvider(editor);
		selectRange(editor, 0, 6, 0, 10); // "beta"
		expect(p.seedTerm?.()).toBe("beta");
	});

	it("returns null for a collapsed selection", () => {
		const editor = editorWith(["alpha beta"]);
		const p = createLexicalSearchProvider(editor);
		selectRange(editor, 0, 3, 0, 3);
		expect(p.seedTerm?.()).toBeNull();
	});

	it("returns null with no selection at all", () => {
		const p = createLexicalSearchProvider(editorWith(["alpha"]));
		expect(p.seedTerm?.()).toBeNull();
	});

	it("returns null for a cross-node selection (single-node only in v1)", () => {
		const editor = editorWith(["alpha", "beta"]);
		const p = createLexicalSearchProvider(editor);
		selectRange(editor, 0, 0, 1, 4); // spans two text nodes
		expect(p.seedTerm?.()).toBeNull();
	});

	it("normalises a backward selection (focus before anchor)", () => {
		const editor = editorWith(["alpha beta gamma"]);
		const p = createLexicalSearchProvider(editor);
		selectRange(editor, 0, 10, 0, 6); // anchor after focus, still "beta"
		expect(p.seedTerm?.()).toBe("beta");
	});
});
