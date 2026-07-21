// @vitest-environment jsdom
import { DateGranularity, type DateValue } from "@brainstorm-os/sdk-types";
import { createHeadlessEditor } from "@lexical/headless";
import {
	$createParagraphNode,
	$getRoot,
	$isElementNode,
	type LexicalEditor,
	type LexicalNode,
} from "lexical";
import { describe, expect, it } from "vitest";
import {
	$createDateFieldNode,
	$isDateFieldNode,
	DateFieldNode,
	type SerializedDateFieldNode,
	dateFieldText,
} from "./date-field-node";

// 2024-03-14T15:09:00.000Z — fixed so formatting is deterministic.
const AT = Date.UTC(2024, 2, 14, 15, 9, 0);
const DATE_VALUE: DateValue = { at: AT, granularity: DateGranularity.Date };

function editorWithDate(): LexicalEditor {
	return createHeadlessEditor({
		namespace: "df",
		nodes: [DateFieldNode],
		onError: (e) => {
			throw e;
		},
	});
}

function seed(editor: LexicalEditor, value: DateValue | null): void {
	editor.update(
		() => {
			const para = $createParagraphNode();
			para.append($createDateFieldNode(value));
			$getRoot().append(para);
		},
		{ discrete: true },
	);
}

function firstField(): LexicalNode | null {
	const para = $getRoot().getFirstChild();
	return $isElementNode(para) ? para.getFirstChild() : null;
}

describe("DateFieldNode", () => {
	it("serialises type / version / at / granularity", () => {
		const editor = editorWithDate();
		seed(editor, DATE_VALUE);
		const root = editor.getEditorState().toJSON().root as unknown as {
			children: { children: SerializedDateFieldNode[] }[];
		};
		const node = root.children[0]?.children[0];
		expect(node?.type).toBe("date-field");
		expect(node?.version).toBe(1);
		expect(node?.at).toBe(AT);
		expect(node?.granularity).toBe(DateGranularity.Date);
	});

	it("defaults to an empty value", () => {
		const editor = editorWithDate();
		seed(editor, null);
		editor.getEditorState().read(() => {
			const node = firstField();
			expect($isDateFieldNode(node) && node.getValue()).toBe(null);
		});
	});

	it("an empty field serialises a null `at` and default granularity", () => {
		const editor = editorWithDate();
		seed(editor, null);
		const root = editor.getEditorState().toJSON().root as unknown as {
			children: { children: SerializedDateFieldNode[] }[];
		};
		const node = root.children[0]?.children[0];
		expect(node?.at).toBe(null);
		expect(node?.granularity).toBe(DateGranularity.Date);
	});

	it("setValue updates the persisted state", () => {
		const editor = editorWithDate();
		seed(editor, null);
		editor.update(
			() => {
				const node = firstField();
				if ($isDateFieldNode(node)) node.setValue(DATE_VALUE);
			},
			{ discrete: true },
		);
		editor.getEditorState().read(() => {
			const node = firstField();
			expect($isDateFieldNode(node) && node.getValue()?.at).toBe(AT);
		});
	});

	it("is inline and renders an ISO date as its plain-text view", () => {
		const editor = editorWithDate();
		seed(editor, DATE_VALUE);
		editor.getEditorState().read(() => {
			const node = firstField();
			if (!$isDateFieldNode(node)) throw new Error("expected date field");
			expect(node.isInline()).toBe(true);
			expect(node.getTextContent()).toBe("2024-03-14");
		});
	});

	it("an empty field has an empty plain-text view", () => {
		const editor = editorWithDate();
		seed(editor, null);
		editor.getEditorState().read(() => {
			const node = firstField();
			if (!$isDateFieldNode(node)) throw new Error("expected date field");
			expect(node.getTextContent()).toBe("");
		});
	});

	it("round-trips through serialize → parse", () => {
		const editor = editorWithDate();
		seed(editor, DATE_VALUE);
		const json = JSON.stringify(editor.getEditorState().toJSON());
		const restored = editorWithDate();
		restored.setEditorState(restored.parseEditorState(JSON.parse(json)));
		restored.getEditorState().read(() => {
			const node = firstField();
			expect($isDateFieldNode(node)).toBe(true);
			if ($isDateFieldNode(node)) {
				expect(node.getValue()?.at).toBe(AT);
				expect(node.getValue()?.granularity).toBe(DateGranularity.Date);
			}
		});
	});

	it("clamps a non-finite imported `at` to an empty value", () => {
		const editor = editorWithDate();
		editor.update(
			() => {
				for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "soon", null]) {
					const node = DateFieldNode.importJSON({
						type: "date-field",
						version: 1,
						at: bad,
						granularity: DateGranularity.Date,
					} as unknown as SerializedDateFieldNode);
					expect(node.getValue()).toBe(null);
				}
			},
			{ discrete: true },
		);
	});

	it("clamps an unknown imported granularity to Date", () => {
		const editor = editorWithDate();
		editor.update(
			() => {
				const node = DateFieldNode.importJSON({
					type: "date-field",
					version: 1,
					at: AT,
					granularity: "century",
				} as unknown as SerializedDateFieldNode);
				expect(node.getValue()?.granularity).toBe(DateGranularity.Date);
			},
			{ discrete: true },
		);
	});
});

describe("dateFieldText", () => {
	it("formats by granularity", () => {
		expect(dateFieldText({ at: AT, granularity: DateGranularity.Date })).toBe("2024-03-14");
		expect(dateFieldText({ at: AT, granularity: DateGranularity.DateTime })).toBe("2024-03-14 15:09");
		expect(dateFieldText({ at: AT, granularity: DateGranularity.Time })).toBe("15:09");
	});

	it("renders an empty string for a null value", () => {
		expect(dateFieldText(null)).toBe("");
	});

	it("renders an empty string for a non-finite epoch", () => {
		expect(dateFieldText({ at: Number.NaN, granularity: DateGranularity.Date })).toBe("");
	});
});
