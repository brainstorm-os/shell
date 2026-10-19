// @vitest-environment jsdom
/** 7.15 — the file list honours Settings → Appearance → "Auto-hide sidebars". */
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodeEditorApp } from "./app";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	localStorage.clear();
	container = document.createElement("div");
	document.body.append(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	document.documentElement.removeAttribute("data-bs-autohide-sidebars");
	localStorage.clear();
});

const files = () => container.querySelector<HTMLElement>(".editor__files");
const render = () =>
	act(() => {
		root = createRoot(container);
		root.render(<CodeEditorApp />);
	});
const pressToggle = () =>
	act(() => {
		window.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "\\",
				...(/mac/i.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }),
				bubbles: true,
			}),
		);
	});

describe("CodeEditorApp — auto-hide file list (7.15)", () => {
	it("without the preference, the shortcut collapses the list out of the tab order", () => {
		render();
		expect(files()?.hasAttribute("inert")).toBe(false);
		pressToggle();
		expect(files()?.hasAttribute("inert")).toBe(true);
		expect(files()?.hasAttribute("data-bs-autohide")).toBe(false);
		expect(container.querySelector(".bs-autohide-edge")).toBeNull();
	});

	it("with the preference on, a collapsed list becomes a hidden overlay the shortcut reveals", () => {
		document.documentElement.setAttribute("data-bs-autohide-sidebars", "on");
		localStorage.setItem("code-editor:nav-open", "false");
		render();
		expect(files()?.getAttribute("data-bs-autohide")).toBe("hidden");
		expect(files()?.hasAttribute("inert")).toBe(true);
		expect(container.querySelector(".bs-autohide-edge")).not.toBeNull();
		pressToggle();
		expect(files()?.getAttribute("data-bs-autohide")).toBe("revealed");
		expect(files()?.hasAttribute("inert")).toBe(false);
	});
});
