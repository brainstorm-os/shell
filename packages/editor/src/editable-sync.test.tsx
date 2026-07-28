// @vitest-environment jsdom
/**
 * `EditableSync` — the `<BrainstormEditor editable={…}>` live-lock contract
 * (Lock-3 owed coverage). `initialConfig.editable` only seeds the FIRST
 * render, so the per-object read-only lock (Journal / Tasks pass
 * `editable={!locked}`) depends on this component pushing every later prop
 * flip onto the live editor. Pins:
 *   1. `undefined` renders nothing and leaves the editor's default (editable).
 *   2. A live `true → false` flip locks the mounted contenteditable.
 *   3. A live `false → true` flip unlocks it again.
 *   4. Locking blurs the contenteditable (via the delegated `EditablePlugin`)
 *      so the caret can't linger in a now-read-only doc.
 */

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Doc } from "yjs";
import { BrainstormEditor, EditableSync } from "./editor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});

async function renderEditor(doc: Doc, editable: boolean | undefined): Promise<void> {
	await act(async () => {
		root.render(
			<BrainstormEditor
				doc={doc}
				docId="lock-test"
				{...(editable !== undefined ? { editable } : {})}
			/>,
		);
	});
	// allow the local provider's queued sync + collaboration bootstrap
	await act(async () => {
		await Promise.resolve();
	});
}

function contentEditableHost(): HTMLElement {
	const host = container.querySelector<HTMLElement>("[contenteditable]");
	if (!host) throw new Error("no contenteditable mounted");
	return host;
}

describe("EditableSync (via <BrainstormEditor editable>)", () => {
	it("renders nothing and leaves the editor editable when the prop is undefined", async () => {
		const doc = new Doc();
		await renderEditor(doc, undefined);
		expect(contentEditableHost().getAttribute("contenteditable")).toBe("true");
	});

	it("locks the live editor when `editable` flips true → false (no remount)", async () => {
		const doc = new Doc();
		await renderEditor(doc, true);
		const host = contentEditableHost();
		expect(host.getAttribute("contenteditable")).toBe("true");

		await renderEditor(doc, false);
		// Same mounted node — the composer must not have remounted.
		expect(contentEditableHost()).toBe(host);
		expect(host.getAttribute("contenteditable")).toBe("false");
	});

	it("unlocks the live editor when `editable` flips false → true", async () => {
		const doc = new Doc();
		await renderEditor(doc, false);
		expect(contentEditableHost().getAttribute("contenteditable")).toBe("false");

		await renderEditor(doc, true);
		expect(contentEditableHost().getAttribute("contenteditable")).toBe("true");
	});

	it("blurs the contenteditable when locking so the caret can't linger", async () => {
		const doc = new Doc();
		await renderEditor(doc, true);
		const host = contentEditableHost();
		host.focus();
		expect(document.activeElement).toBe(host);

		await renderEditor(doc, false);
		expect(document.activeElement).not.toBe(host);
	});

	it("EditableSync itself renders null for undefined (no plugin mounted)", () => {
		expect(EditableSync({ editable: undefined })).toBeNull();
	});
});
