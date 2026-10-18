// @vitest-environment jsdom
import type { LexicalEditor } from "lexical";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OutlineEntry } from "../editor/outline";
import { OutlinePanel } from "./outline-panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ENTRIES: OutlineEntry[] = [
	{ key: "a", text: "Alpha", level: 1 },
	{ key: "b", text: "Beta", level: 2 },
	{ key: "c", text: "", level: 2 },
];

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
	act(() => root?.unmount());
	host?.remove();
	root = null;
	host = null;
	vi.unstubAllGlobals();
});

function harness(tops: Record<string, number>) {
	const scrolled: string[] = [];
	const els = new Map<string, HTMLElement>();
	for (const key of Object.keys(tops)) {
		const el = document.createElement("h2");
		el.getBoundingClientRect = () => ({ top: tops[key] ?? 0 }) as DOMRect;
		el.scrollIntoView = () => scrolled.push(key);
		els.set(key, el);
	}
	const editor = { getElementByKey: (k: string) => els.get(k) ?? null } as unknown as LexicalEditor;
	const scroller = document.createElement("div");
	scroller.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
	const editorRef = { current: editor };
	const scrollContainer = () => scroller;
	const mount = (hasNote: boolean, entries: OutlineEntry[]) => {
		if (!host) {
			host = document.createElement("div");
			document.body.appendChild(host);
			root = createRoot(host);
		}
		act(() => {
			root?.render(
				<OutlinePanel
					hasNote={hasNote}
					entries={entries}
					editorRef={editorRef}
					scrollContainer={scrollContainer}
				/>,
			);
		});
		return host;
	};
	return { mount, scroller, scrolled, tops };
}

const options = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>("[role='option']")];

describe("OutlinePanel", () => {
	it("shows a no-note empty state, then a no-headings one", () => {
		const h = harness({});
		expect(h.mount(false, []).textContent).toContain("No note open");
		expect(h.mount(true, []).textContent).toContain("No headings yet");
	});

	it("indents by depth relative to the shallowest heading and labels untitled ones", () => {
		const el = harness({ a: 0, b: 100, c: 200 }).mount(true, ENTRIES);
		const items = options(el);
		expect(items.map((i) => i.getAttribute("data-depth"))).toEqual(["0", "1", "1"]);
		expect(items[2]?.textContent).toBe("Untitled heading");
	});

	it("click scrolls the heading into view", () => {
		const h = harness({ a: 0, b: 100, c: 200 });
		const el = h.mount(true, ENTRIES);
		act(() => options(el)[1]?.querySelector("button")?.click());
		expect(h.scrolled).toEqual(["b"]);
	});

	it("keyboard: ArrowDown moves the cursor and Enter reveals", () => {
		const h = harness({ a: 0, b: 100, c: 200 });
		const el = h.mount(true, ENTRIES);
		const list = el.querySelector<HTMLElement>("[role='listbox']");
		expect(list).not.toBeNull();
		const key = (k: string) =>
			act(() => {
				list?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
			});
		key("ArrowDown");
		key("Enter");
		expect(h.scrolled).toEqual(["b"]);
	});

	it("tracks the heading the reader has scrolled to", () => {
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
			cb(0);
			return 1;
		});
		const tops = { a: -300, b: 20, c: 400 };
		const h = harness(tops);
		const el = h.mount(true, ENTRIES);
		const current = () => options(el).findIndex((i) => i.getAttribute("aria-current") === "location");
		expect(current()).toBe(1);
		tops.b = -100;
		tops.c = 10;
		act(() => {
			h.scroller.dispatchEvent(new Event("scroll"));
		});
		expect(current()).toBe(2);
	});
});
