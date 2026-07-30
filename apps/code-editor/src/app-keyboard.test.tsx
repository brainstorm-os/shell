// @vitest-environment jsdom
/**
 * KBN-A-code-editor file-sidebar keyboard test, against the React app. With
 * no `window.brainstorm` runtime present the app falls back to the in-memory
 * demo dataset — whose paths are all nested (`snippets/greet.ts`,
 * `config/app.json`, …), so rendering it shows the real folder TREE.
 *
 * We assert the sidebar is a `role="tree"` driven by the shared
 * `useTreeKeyboard` reducer (the container is the single tab stop, rows are
 * `treeitem`s carrying `aria-level` / `aria-expanded`), that ArrowDown roves
 * the active row, and that ArrowLeft collapses a folder — hiding its subtree
 * from the flat visible array.
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

const list = () => document.querySelector<HTMLElement>(".editor__file-list");
const key = (name: string) =>
	act(() => {
		list()?.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
	});

describe("file sidebar keyboard (KBN-A-code-editor)", () => {
	beforeEach(() => {
		act(() => {
			root = createRoot(container);
			root.render(<CodeEditorApp />);
		});
	});

	it("renders the sidebar as a tree of folders and files", () => {
		expect(list()).not.toBeNull();
		expect(list()?.getAttribute("role")).toBe("tree");
		expect(list()?.tabIndex).toBe(0);

		const folders = list()?.querySelectorAll<HTMLElement>('.editor__folder[role="treeitem"]');
		expect(folders?.length ?? 0).toBeGreaterThan(1);
		// The demo paths are all nested, so every folder is level 1 and expanded
		// by default, and every file sits one level deeper.
		for (const folder of folders ?? []) {
			expect(folder.getAttribute("aria-level")).toBe("1");
			expect(folder.getAttribute("aria-expanded")).toBe("true");
		}
		const files = list()?.querySelectorAll<HTMLElement>(".editor__file[data-file-id]");
		expect(files?.length ?? 0).toBeGreaterThan(1);
		for (const file of files ?? []) {
			expect(file.getAttribute("role")).toBe("treeitem");
			expect(file.getAttribute("aria-level")).toBe("2");
		}
	});

	it("Home / ArrowDown rove the active row across folders and files", () => {
		key("Home");
		const first = list()?.querySelector<HTMLElement>('[aria-selected="true"]');
		// Folders sort before files at every level, so Home lands on one.
		expect(first?.classList.contains("editor__folder")).toBe(true);

		key("ArrowDown");
		const second = list()?.querySelectorAll<HTMLElement>('[aria-selected="true"]');
		expect(second).toHaveLength(1);
		expect(second?.[0]).not.toBe(first);
		// One step down from a folder is its first child — a file, which the
		// tree also OPENS (selection follows focus on file rows).
		expect(second?.[0]?.dataset.fileId).toBeDefined();
		expect(second?.[0]?.getAttribute("aria-current")).toBe("true");
	});

	it("ArrowLeft collapses the focused folder and hides its subtree", () => {
		// Home lands on the first visible row — a folder, since folders sort
		// before files at every level.
		key("Home");
		const folder = list()?.querySelector<HTMLElement>('[aria-selected="true"]');
		expect(folder?.classList.contains("editor__folder")).toBe(true);
		const path = folder?.dataset.folderPath ?? "";
		expect(path).not.toBe("");
		const before = list()?.querySelectorAll(".editor__file").length ?? 0;

		key("ArrowLeft");
		expect(
			list()
				?.querySelector<HTMLElement>(`[data-folder-path="${path}"]`)
				?.getAttribute("aria-expanded"),
		).toBe("false");
		expect(list()?.querySelectorAll(".editor__file").length ?? 0).toBeLessThan(before);

		key("ArrowRight");
		expect(list()?.querySelectorAll(".editor__file").length ?? 0).toBe(before);
	});
});
