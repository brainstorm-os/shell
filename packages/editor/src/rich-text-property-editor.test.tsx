// @vitest-environment jsdom

import { RICH_TEXT_STATE_MAX_CHARS, type RichTextValue } from "@brainstorm-os/sdk-types";
import { createRef } from "react";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CompactEditor,
	type CompactEditorHandle,
	type CompactEditorPayload,
	isSeedableState,
	registeredNodeTypes,
} from "./compact-editor";
import { RichTextPropertyEditor, richTextValueFromPayload } from "./rich-text-property-editor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

function content(): string {
	return container.querySelector('[contenteditable="true"]')?.textContent ?? "";
}

/** A real serialized state, produced by the composer itself. */
async function stateFor(text: string): Promise<CompactEditorPayload> {
	const ref = createRef<CompactEditorHandle>();
	let payload: CompactEditorPayload | null = null;
	await act(async () => {
		root.render(
			<CompactEditor
				ref={ref}
				submitOnEnter={false}
				onSubmit={(p) => {
					payload = p;
				}}
			/>,
		);
	});
	await act(async () => {
		ref.current?.setText(text);
		ref.current?.submit();
	});
	if (!payload) throw new Error("no payload");
	return payload;
}

describe("RichTextPropertyEditor (9.12.26)", () => {
	it("keeps both halves of a compact-editor payload", () => {
		const v = richTextValueFromPayload({ state: "{s}", text: "t", html: "", isEmpty: false });
		expect(v).toEqual({ text: "t", state: "{s}" });
	});

	it("re-opens a stored serialized state", async () => {
		const stored = richTextValueFromPayload(await stateFor("Stored body"));
		act(() => root.unmount());
		root = createRoot(container);
		await act(async () => {
			root.render(
				<RichTextPropertyEditor
					initialValue={stored}
					ariaLabel="Notes"
					toolbar={false}
					onChange={() => undefined}
				/>,
			);
		});
		expect(content()).toBe("Stored body");
	});

	it("seeds plain text when there is no state, and ignores an unparseable one", async () => {
		const value: RichTextValue = { text: "Line one\nLine two", state: "not json" };
		await act(async () => {
			root.render(
				<RichTextPropertyEditor
					initialValue={value}
					ariaLabel="Notes"
					toolbar={false}
					onChange={() => undefined}
				/>,
			);
		});
		expect(container.querySelectorAll('[contenteditable="true"] p')).toHaveLength(2);
		expect(content()).toBe("Line oneLine two");
	});

	it("degrades a state with an unregistered node type to its text, without crashing", async () => {
		const foreign = JSON.stringify({
			root: {
				type: "root",
				version: 1,
				children: [
					{
						type: "heading",
						tag: "h1",
						version: 1,
						children: [{ type: "text", text: "Imported", version: 1 }],
					},
				],
			},
		});
		const errors: unknown[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => errors.push(args);
		try {
			await act(async () => {
				root.render(
					<RichTextPropertyEditor
						initialValue={{ text: "Imported", state: foreign }}
						ariaLabel="Notes"
						toolbar={false}
						onChange={() => undefined}
					/>,
				);
			});
		} finally {
			console.error = original;
		}
		expect(content()).toBe("Imported");
		expect(errors).toEqual([]);
	});

	it("refuses oversized or malformed states and never persists an oversized one", () => {
		const types = registeredNodeTypes([]);
		const ok = JSON.stringify({
			root: { type: "root", children: [{ type: "paragraph", children: [] }] },
		});
		expect(isSeedableState(ok, types)).toBe(true);
		expect(isSeedableState(JSON.stringify({ root: { type: "root", children: "x" } }), types)).toBe(
			false,
		);
		expect(isSeedableState(" ".repeat(RICH_TEXT_STATE_MAX_CHARS + 1), types)).toBe(false);
		const big = "x".repeat(RICH_TEXT_STATE_MAX_CHARS + 1);
		expect(richTextValueFromPayload({ state: big, text: "t", html: "", isEmpty: false })).toEqual({
			text: "t",
		});
	});
});
