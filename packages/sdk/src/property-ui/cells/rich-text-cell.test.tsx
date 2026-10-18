// @vitest-environment jsdom
import {
	CellPresentation,
	type CellProps,
	type PropertyDef,
	PropertyView,
	ValueType,
} from "@brainstorm-os/sdk-types";
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DictionaryStore } from "../dictionary-store";
import { PropertyStore } from "../property-store";
import type { RichTextEditorProps } from "../seams";
import { PropertiesContext } from "../use-properties";
import { getCell } from "./index";
import { RichTextCell } from "./rich-text-cell";

const DEF: PropertyDef = { key: "notes", name: "Notes", icon: null, valueType: ValueType.RichText };

/** A stand-in for the editor package's CompactEditor seam: a textarea that
 *  reports `{ text, state }` on every edit. */
function FakeEditor({ initialValue, ariaLabel, onChange }: RichTextEditorProps) {
	return createElement("textarea", {
		"aria-label": ariaLabel,
		"data-fake-editor": "1",
		defaultValue: initialValue?.text ?? "",
		onInput: (e: { currentTarget: HTMLTextAreaElement }) =>
			onChange({ text: e.currentTarget.value, state: `S:${e.currentTarget.value}` }),
	});
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
	document.body.replaceChildren();
});

function render(props: Partial<CellProps> & { onChange: CellProps["onChange"] }, seam = true) {
	const ctx = {
		propertyStore: new PropertyStore({
			backend: { setProperty: async () => undefined, removeProperty: async () => undefined },
		}),
		dictionaryStore: new DictionaryStore({
			backend: { setDictionary: async () => undefined, removeDictionary: async () => undefined },
		}),
		ready: true,
		...(seam ? { richTextEditor: FakeEditor } : {}),
	};
	act(() => {
		root.render(
			createElement(
				PropertiesContext.Provider,
				{ value: ctx },
				createElement(RichTextCell, { property: DEF, value: null, noteId: "n1", ...props }),
			),
		);
	});
}

function type(el: HTMLTextAreaElement, text: string): void {
	act(() => {
		const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
		setter?.call(el, text);
		el.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

function pressEscape(): void {
	act(() => {
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	});
}

describe("RichTextCell (9.12.26)", () => {
	it("is the registered cell for RichText's Block view", () => {
		expect(getCell(ValueType.RichText, PropertyView.Block)).toBe(RichTextCell);
	});

	it("rests as the one-line plain projection in a grid", () => {
		render({ value: { text: "Hello world", state: "{}" }, onChange: vi.fn() });
		const trigger = container.querySelector(".bs-cell-richtext");
		expect(trigger?.textContent).toBe("Hello world");
		expect(container.querySelector("[data-fake-editor]")).toBeNull();
	});

	it("edits in a popover and persists once, on close", () => {
		const onChange = vi.fn();
		render({ value: { text: "a" }, onChange });
		act(() => container.querySelector<HTMLButtonElement>(".bs-cell-richtext")?.click());
		const editor = document.querySelector<HTMLTextAreaElement>("[data-fake-editor]");
		expect(editor).not.toBeNull();
		type(editor as HTMLTextAreaElement, "b");
		type(editor as HTMLTextAreaElement, "bold move");
		expect(onChange).not.toHaveBeenCalled();
		pressEscape();
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith({ text: "bold move", state: "S:bold move" });
	});

	it("closing without an edit writes nothing; clearing the text stores null", () => {
		const onChange = vi.fn();
		render({ value: { text: "keep" }, onChange });
		act(() => container.querySelector<HTMLButtonElement>(".bs-cell-richtext")?.click());
		pressEscape();
		expect(onChange).not.toHaveBeenCalled();
		act(() => container.querySelector<HTMLButtonElement>(".bs-cell-richtext")?.click());
		type(document.querySelector("[data-fake-editor]") as HTMLTextAreaElement, "  ");
		pressEscape();
		expect(onChange).toHaveBeenCalledWith(null);
	});

	it("mounts the full editor in place in an inspector, persisting on blur", () => {
		const onChange = vi.fn();
		render({ value: { text: "x" }, onChange, presentation: CellPresentation.Expanded });
		const editor = container.querySelector<HTMLTextAreaElement>(".bs-cell-richtext-editor textarea");
		expect(editor).not.toBeNull();
		type(editor as HTMLTextAreaElement, "x y");
		act(() => {
			editor?.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
		});
		expect(onChange).toHaveBeenCalledWith({ text: "x y", state: "S:x y" });
	});

	it("is read-only text in a locked inspector", () => {
		render({
			value: { text: "line 1" },
			onChange: vi.fn(),
			readOnly: true,
			presentation: CellPresentation.Expanded,
		});
		expect(container.querySelector(".bs-cell-richtext-editor")).toBeNull();
		expect(container.textContent).toBe("line 1");
	});

	it("falls back to plain-text editing with no editor seam", () => {
		render({ value: "legacy text", onChange: vi.fn() }, false);
		expect(container.querySelector(".bs-cell-richtext")?.textContent).toBe("legacy text");
		act(() => container.querySelector<HTMLButtonElement>(".bs-cell-richtext")?.click());
		expect(document.querySelector(".bs-cell-richtext-pop textarea")).not.toBeNull();
	});
});
