// @vitest-environment jsdom
/**
 * KBN-A-code-editor file-sidebar keyboard test, against the React app. With
 * no `window.brainstorm` runtime present the app falls back to the in-memory
 * demo dataset, so rendering it shows the real file list against real rows.
 * We assert the sidebar is a listbox driven by the shared composite-keyboard
 * reducer (the container is the single tab stop + holds `aria-activedescendant`)
 * and that ArrowDown moves the selection (aria-current) to the next row.
 */
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodeEditorApp } from "./app";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	container = document.createElement("div");
	document.body.append(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	window.brainstorm = undefined;
});

describe("file sidebar keyboard (KBN-A-code-editor)", () => {
	it("renders the file list as a listbox and roves on ArrowDown", () => {
		act(() => {
			root = createRoot(container);
			root.render(<CodeEditorApp />);
		});

		const list = document.querySelector<HTMLElement>(".editor__file-list");
		expect(list).not.toBeNull();
		expect(list?.getAttribute("role")).toBe("listbox");
		// The composite reducer makes the container the single tab stop and
		// points `aria-activedescendant` at the selected (current) row.
		expect(list?.tabIndex).toBe(0);

		const rows = list?.querySelectorAll<HTMLElement>('.editor__file[role="option"]');
		expect(rows?.length ?? 0).toBeGreaterThan(1);
		const current = list?.querySelector<HTMLElement>('.editor__file[aria-current="true"]');
		expect(list?.getAttribute("aria-activedescendant")).toBe(current?.id);

		// ArrowDown on the listbox moves selection (aria-current) to the next row.
		act(() => {
			list?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		});

		const nowCurrent = document.querySelectorAll<HTMLElement>('[role="option"][aria-current="true"]');
		expect(nowCurrent).toHaveLength(1);
		expect(nowCurrent[0]?.id).not.toBe(current?.id);
	});
});
