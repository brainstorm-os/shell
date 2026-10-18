// @vitest-environment jsdom

import type { RichTextValue } from "@brainstorm-os/sdk-types";
import { createRef } from "react";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CompactEditor,
	type CompactEditorHandle,
	type CompactEditorPayload,
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
});
