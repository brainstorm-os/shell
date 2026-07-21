// @vitest-environment jsdom
/**
 * Render + interaction tests for TagCell / TagListCell against a
 * fixture dictionary. Mounts the cell inside a hand-built
 * `PropertiesContext` (no SDK runtime boot), opens the picker, asserts
 * chip rendering with the item's own colour, single vs multi
 * selection, and that "Manage values" routes to the editor store.
 */

import type { CellProps, Dictionary, LabeledValue, PropertyDef } from "@brainstorm-os/sdk-types";
import { CARDINALITY_HARD_MAX, PropertyView, ValueType } from "@brainstorm-os/sdk-types";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dictionaryEditorStore } from "../dictionary-editor-store";
import { DictionaryStore } from "../dictionary-store";
import { PropertyStore } from "../property-store";
import { PropertiesContext } from "../use-properties";
import { TagCell } from "./tag-cell";

const NOOP = { setProperty: async () => {}, removeProperty: async () => {} };
const NOOP_DICT = { setDictionary: async () => {}, removeDictionary: async () => {} };

const DICT: Dictionary = {
	id: "dict_status",
	name: "Status",
	items: [
		{ id: "di_todo", label: "To do", icon: null, sortIndex: 0, colour: "#3366ff" },
		{ id: "di_doing", label: "Doing", icon: null, sortIndex: 1, colour: "#ffaa00" },
		{ id: "di_done", label: "Done", icon: null, sortIndex: 2 },
		{ id: "di_old", label: "Legacy", icon: null, sortIndex: 3, archivedAt: 1 },
	],
};

function selectDef(): PropertyDef & { valueType: ValueType.Text } {
	return {
		key: "prop_status",
		name: "Status",
		icon: null,
		valueType: ValueType.Text,
		vocabulary: { dictionaryId: "dict_status" },
		count: { min: 0, max: 1 },
		display: { view: PropertyView.Tag },
	};
}

function multiDef(): PropertyDef & { valueType: ValueType.Text } {
	return {
		key: "prop_tags",
		name: "Tags",
		icon: null,
		valueType: ValueType.Text,
		vocabulary: { dictionaryId: "dict_status" },
		count: { min: 0, max: CARDINALITY_HARD_MAX },
		display: { view: PropertyView.TagList },
	};
}

type Harness = { container: HTMLDivElement; root: Root; cleanup: () => void };

function mount(): Harness {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	return {
		container,
		root,
		cleanup: () => {
			act(() => root.unmount());
			container.remove();
		},
	};
}

function renderCell(h: Harness, props: CellProps) {
	const propertyStore = new PropertyStore({ backend: NOOP });
	const dictionaryStore = new DictionaryStore({ backend: NOOP_DICT });
	dictionaryStore.applySnapshot({ [DICT.id]: DICT });
	propertyStore.applySnapshot({ [props.property.key]: props.property });
	act(() => {
		h.root.render(
			<PropertiesContext.Provider value={{ propertyStore, dictionaryStore, ready: true }}>
				<TagCell {...props} />
			</PropertiesContext.Provider>,
		);
	});
}

describe("TagCell (scalar / Select)", () => {
	let h: Harness;
	beforeEach(() => {
		h = mount();
	});
	afterEach(() => {
		h.cleanup();
		dictionaryEditorStore.close();
	});

	it("renders the empty placeholder when no value is set", () => {
		renderCell(h, {
			property: selectDef(),
			value: null,
			onChange: vi.fn(),
			noteId: "n_1",
		});
		expect(h.container.querySelector(".bs-cell-tag-empty")).not.toBeNull();
	});

	it("portals the open panel to <body>, not the cell's container (F-018)", () => {
		// Rendered in place, the panel's `z-index`/`fixed` are trapped inside the
		// host's stacking context (e.g. a transformed grid), so an overlay like
		// the Details inspector paints over it and eats clicks. It must mount at
		// the document root.
		renderCell(h, { property: selectDef(), value: null, onChange: vi.fn(), noteId: "n_1" });
		act(() => {
			h.container.querySelector<HTMLButtonElement>(".bs-cell-tag-trigger")?.click();
		});
		const panel = document.querySelector<HTMLElement>(".bs-cell-pop");
		expect(panel).not.toBeNull();
		expect(h.container.contains(panel)).toBe(false);
		expect(panel?.parentElement).toBe(document.body);
	});

	it("renders the selected item's chip with its own colour", () => {
		renderCell(h, {
			property: selectDef(),
			value: "di_doing",
			onChange: vi.fn(),
			noteId: "n_1",
		});
		const chip = h.container.querySelector<HTMLElement>(".bs-cell-tag");
		expect(chip?.textContent).toContain("Doing");
		expect(chip?.style.background).toContain("#ffaa00");
	});

	it("opens the picker and emits the picked item id (scalar)", () => {
		const onChange = vi.fn();
		renderCell(h, { property: selectDef(), value: null, onChange, noteId: "n_1" });
		act(() => {
			h.container.querySelector<HTMLButtonElement>(".bs-cell-tag-trigger")?.click();
		});
		const rows = document.querySelectorAll<HTMLButtonElement>(".bs-cell-pop-row");
		// Archived item ("Legacy") is excluded from the picker.
		expect(rows.length).toBe(3);
		act(() => {
			rows[0]?.click();
		});
		expect(onChange).toHaveBeenCalledWith("di_todo");
	});

	it("'Manage values' routes to the dictionary-editor store", () => {
		renderCell(h, {
			property: selectDef(),
			value: null,
			onChange: vi.fn(),
			noteId: "n_1",
		});
		act(() => {
			h.container.querySelector<HTMLButtonElement>(".bs-cell-tag-trigger")?.click();
		});
		act(() => {
			document.querySelector<HTMLButtonElement>(".bs-cell-pop-foot")?.click();
		});
		expect(dictionaryEditorStore.getActive()).toBe("dict_status");
	});
});

describe("TagListCell (multi / MultiSelect)", () => {
	let h: Harness;
	beforeEach(() => {
		h = mount();
	});
	afterEach(() => {
		h.cleanup();
		dictionaryEditorStore.close();
	});

	it("renders one chip per selected element", () => {
		const value: LabeledValue<string>[] = [{ value: "di_todo" }, { value: "di_done" }];
		renderCell(h, { property: multiDef(), value, onChange: vi.fn(), noteId: "n_1" });
		expect(h.container.querySelectorAll(".bs-cell-tag").length).toBe(2);
	});

	it("appends a picked id to the multi envelope without closing", () => {
		const onChange = vi.fn();
		const value: LabeledValue<string>[] = [{ value: "di_todo" }];
		renderCell(h, { property: multiDef(), value, onChange, noteId: "n_1" });
		act(() => {
			h.container.querySelector<HTMLButtonElement>(".bs-cell-tag-trigger")?.click();
		});
		const rows = document.querySelectorAll<HTMLButtonElement>(".bs-cell-pop-row");
		act(() => {
			rows[1]?.click();
		});
		expect(onChange).toHaveBeenCalledWith([{ value: "di_todo" }, { value: "di_doing" }]);
	});

	it("a keydown on a chip's remove button does NOT open the picker (no keydown bubble to trigger)", () => {
		// Regression: the trigger renders as a role=button div with an onKeyDown
		// that opens the picker on Enter/Space. A key pressed while focus is on a
		// nested chip ✕ must run its own action, not bubble up and open the picker.
		const value: LabeledValue<string>[] = [{ value: "di_todo" }];
		renderCell(h, { property: multiDef(), value, onChange: vi.fn(), noteId: "n_1" });
		const removeBtn = h.container.querySelector<HTMLButtonElement>(".bs-cell-tag-remove");
		expect(removeBtn).not.toBeNull();
		act(() => {
			removeBtn?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		});
		expect(document.querySelector(".bs-cell-pop")).toBeNull();
	});

	it("toggles an already-selected element off", () => {
		const onChange = vi.fn();
		const value: LabeledValue<string>[] = [{ value: "di_todo" }, { value: "di_doing" }];
		renderCell(h, { property: multiDef(), value, onChange, noteId: "n_1" });
		act(() => {
			h.container.querySelector<HTMLButtonElement>(".bs-cell-tag-trigger")?.click();
		});
		const rows = document.querySelectorAll<HTMLButtonElement>(".bs-cell-pop-row");
		act(() => {
			rows[0]?.click();
		});
		expect(onChange).toHaveBeenCalledWith([{ value: "di_doing" }]);
	});
});

describe("TagPicker keyboard (KBN-G-roles 12.4 — shared useCellOptionsKeyboard)", () => {
	let h: Harness;
	beforeEach(() => {
		h = mount();
	});
	afterEach(() => {
		h.cleanup();
		dictionaryEditorStore.close();
	});

	function openMulti(onChange: () => void) {
		renderCell(h, { property: multiDef(), value: [], onChange, noteId: "n_1" });
		act(() => {
			h.container.querySelector<HTMLButtonElement>(".bs-cell-tag-trigger")?.click();
		});
	}

	function key(el: Element | null, k: string) {
		act(() => {
			el?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
		});
	}

	it("stamps combobox / listbox / option roles from the hook (no hand-written literals)", () => {
		openMulti(vi.fn());
		const input = document.querySelector<HTMLInputElement>(".bs-cell-pop-input");
		const list = document.querySelector<HTMLElement>(".bs-cell-pop-list");
		const rows = document.querySelectorAll<HTMLButtonElement>(".bs-cell-pop-row");
		expect(input?.getAttribute("role")).toBe("combobox");
		expect(list?.getAttribute("role")).toBe("listbox");
		expect(list?.getAttribute("aria-multiselectable")).toBe("true");
		expect([...rows].every((r) => r.getAttribute("role") === "option")).toBe(true);
		// The active descendant starts on the first option.
		expect(input?.getAttribute("aria-activedescendant")).toBe(rows[0]?.id);
	});

	it("ArrowDown moves the active descendant; Enter activates that option", () => {
		const onChange = vi.fn();
		openMulti(onChange);
		const input = document.querySelector<HTMLInputElement>(".bs-cell-pop-input");
		const rows = document.querySelectorAll<HTMLButtonElement>(".bs-cell-pop-row");
		key(input, "ArrowDown");
		expect(input?.getAttribute("aria-activedescendant")).toBe(rows[1]?.id);
		key(input, "Enter");
		// Visible order is To do, Doing, Done → index 1 is di_doing.
		expect(onChange).toHaveBeenCalledWith([{ value: "di_doing" }]);
	});

	it("reflects membership via aria-selected, not the keyboard cursor", () => {
		renderCell(h, {
			property: multiDef(),
			value: [{ value: "di_done" }],
			onChange: vi.fn(),
			noteId: "n_1",
		});
		act(() => {
			h.container.querySelector<HTMLButtonElement>(".bs-cell-tag-trigger")?.click();
		});
		const rows = document.querySelectorAll<HTMLButtonElement>(".bs-cell-pop-row");
		// di_done is index 2 (todo, doing, done) → the only aria-selected row,
		// even though the cursor (active descendant) starts at index 0.
		expect(rows[2]?.getAttribute("aria-selected")).toBe("true");
		expect(rows[0]?.getAttribute("aria-selected")).toBe("false");
	});
});
