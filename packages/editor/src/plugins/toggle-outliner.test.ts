import { createHeadlessEditor } from "@lexical/headless";
import {
	$createParagraphNode,
	$createTextNode,
	$getRoot,
	$getSelection,
	$isElementNode,
	$isRangeSelection,
	type LexicalEditor,
	type LexicalNode,
	type TextNode,
} from "lexical";
import { describe, expect, it } from "vitest";
import { ToggleVariant } from "../block-types";
import { $createToggleNode, $isToggleNode, ToggleNode } from "../nodes/toggle-node";
import { $enterOnSummary, $indentToggle, $outdentToggle, $summaryToggle } from "./toggle-outliner";

function editor(): LexicalEditor {
	return createHeadlessEditor({
		namespace: "outliner",
		nodes: [ToggleNode],
		onError: (e) => {
			throw e;
		},
	});
}

/** `[summary, ...children]` — a string child is a summary/body paragraph. */
type Spec = { t: string; kids?: Spec[] } | string;

function build(spec: Spec): LexicalNode {
	if (typeof spec === "string") {
		const p = $createParagraphNode();
		if (spec) p.append($createTextNode(spec));
		return p;
	}
	const toggle = $createToggleNode(ToggleVariant.Paragraph);
	toggle.append(build(spec.t) as never);
	const kids = spec.kids ?? [""];
	for (const k of kids) toggle.append(build(k) as never);
	return toggle;
}

function shape(node: LexicalNode): unknown {
	if ($isToggleNode(node)) {
		const [summary, ...body] = node.getChildren();
		return { t: summary?.getTextContent() ?? "", kids: body.map(shape) };
	}
	return $isElementNode(node) ? node.getTextContent() : node.getType();
}

function doc(e: LexicalEditor): unknown {
	return e.getEditorState().read(() => $getRoot().getChildren().map(shape));
}

function setup(specs: Spec[], caretIn: string, offset?: number): LexicalEditor {
	const e = editor();
	e.update(
		() => {
			for (const s of specs) $getRoot().append(build(s));
			const target = $getRoot()
				.getAllTextNodes()
				.find((n: TextNode) => n.getTextContent() === caretIn);
			target?.select(offset ?? caretIn.length, offset ?? caretIn.length);
		},
		{ discrete: true },
	);
	return e;
}

function act(e: LexicalEditor, fn: (t: ToggleNode) => unknown): unknown {
	let out: unknown;
	e.update(
		() => {
			const t = $summaryToggle();
			out = t ? fn(t) : "no-toggle";
		},
		{ discrete: true },
	);
	return out;
}

describe("$summaryToggle", () => {
	it("is the toggle when the caret is on its summary, null in its body", () => {
		const e = setup([{ t: "A", kids: ["body"] }], "body");
		expect(act(e, () => true)).toBe("no-toggle");
		const f = setup([{ t: "A", kids: ["body"] }], "A");
		expect(act(f, () => true)).toBe(true);
	});
});

describe("indent / outdent", () => {
	it("Tab nests a toggle under the one above, replacing its empty body", () => {
		const e = setup([{ t: "A" }, { t: "B" }], "B");
		act(e, (t) => $indentToggle(t));
		expect(doc(e)).toEqual([{ t: "A", kids: [{ t: "B", kids: [""] }] }]);
	});

	it("Tab keeps an existing body and appends after it", () => {
		const e = setup([{ t: "A", kids: ["note"] }, { t: "B" }], "B");
		act(e, (t) => $indentToggle(t));
		expect(doc(e)).toEqual([{ t: "A", kids: ["note", { t: "B", kids: [""] }] }]);
	});

	it("Tab with no toggle above is a no-op", () => {
		const e = setup(["para", { t: "B" }], "B");
		expect(act(e, (t) => $indentToggle(t))).toBeNull();
		expect(doc(e)).toEqual(["para", { t: "B", kids: [""] }]);
	});

	it("Shift+Tab moves a nested toggle out after its parent", () => {
		const e = setup([{ t: "A", kids: [{ t: "B" }] }], "B");
		expect(act(e, (t) => $outdentToggle(t))).toBe(true);
		expect(doc(e)).toEqual([
			{ t: "A", kids: [""] },
			{ t: "B", kids: [""] },
		]);
	});

	it("Shift+Tab at top level does nothing", () => {
		const e = setup([{ t: "A" }], "A");
		expect(act(e, (t) => $outdentToggle(t))).toBe(false);
	});
});

describe("Enter on a summary", () => {
	it("at the end starts an empty sibling toggle with the caret in it", () => {
		const e = setup([{ t: "Alpha" }], "Alpha");
		act(e, (t) => $enterOnSummary(t));
		expect(doc(e)).toEqual([
			{ t: "Alpha", kids: [""] },
			{ t: "", kids: [""] },
		]);
		const inSecond = e.getEditorState().read(() => {
			const sel = $getSelection();
			return $isRangeSelection(sel)
				? sel.anchor.getNode().getTopLevelElement() === $getRoot().getLastChild()
				: false;
		});
		expect(inSecond).toBe(true);
	});

	it("mid-text splits the summary into the new sibling", () => {
		const e = setup([{ t: "AlphaBeta" }], "AlphaBeta", 5);
		act(e, (t) => $enterOnSummary(t));
		expect(doc(e)).toEqual([
			{ t: "Alpha", kids: [""] },
			{ t: "Beta", kids: [""] },
		]);
	});

	it("on an empty nested summary outdents instead", () => {
		const e = setup([{ t: "A", kids: [{ t: "B" }, { t: "" }] }], "B");
		e.update(
			() => {
				const parent = $getRoot().getFirstChild();
				const last = $isToggleNode(parent) ? parent.getLastChild() : null;
				if ($isToggleNode(last)) (last.getFirstChild() as unknown as { select(): void }).select();
			},
			{ discrete: true },
		);
		act(e, (t) => $enterOnSummary(t));
		expect(doc(e)).toEqual([
			{ t: "A", kids: [{ t: "B", kids: [""] }] },
			{ t: "", kids: [""] },
		]);
	});

	it("on an empty top-level toggle with an empty body turns it back into a paragraph", () => {
		const e = setup(["x", { t: "" }], "x");
		e.update(
			() => {
				const toggle = $getRoot().getLastChild();
				if ($isToggleNode(toggle)) (toggle.getFirstChild() as unknown as { select(): void }).select();
			},
			{ discrete: true },
		);
		act(e, (t) => $enterOnSummary(t));
		expect(doc(e)).toEqual(["x", ""]);
	});
});
