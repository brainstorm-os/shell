// @vitest-environment jsdom
/**
 * Render + interaction tests for the property-editing cells added in the
 * "proper editing flows" pass: ToggleCell, RatingCell, MultilineCell, and
 * the TagPicker's inline "Create '<query>'" affordance.
 */

import type { CellProps, Dictionary, PropertyDef } from "@brainstorm-os/sdk-types";
import { ValueType } from "@brainstorm-os/sdk-types";
import { type ComponentType, type ReactNode, act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DictionaryStore } from "../dictionary-store";
import { DEFAULT_PROPERTY_UI_LABELS } from "../seams";
import { PropertiesContext } from "../use-properties";
import { DateCell } from "./date-cell";
import { MultilineCell } from "./multiline-cell";
import { PlainCell } from "./plain-cell";
import { ProgressBarCell } from "./progress-cell";
import { RatingCell } from "./rating-cell";
import { TagCell } from "./tag-cell";
import { ToggleCell } from "./toggle-cell";

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

function render(h: Harness, Cell: ComponentType<CellProps>, props: CellProps) {
	act(() => {
		h.root.render(createElement(Cell, props));
	});
}

const def = (over: Partial<PropertyDef> & { valueType: ValueType }): PropertyDef => ({
	key: "prop_x",
	name: "X",
	icon: null,
	...over,
});

describe("ToggleCell", () => {
	let h: Harness;
	beforeEach(() => {
		h = mount();
	});
	afterEach(() => h.cleanup());

	it("reflects the boolean and flips it on click", () => {
		const onChange = vi.fn();
		render(h, ToggleCell, {
			property: def({ valueType: ValueType.Boolean }),
			value: false,
			onChange,
			noteId: "n1",
		});
		const sw = h.container.querySelector<HTMLButtonElement>(".bs-cell-toggle");
		expect(sw?.getAttribute("role")).toBe("switch");
		expect(sw?.getAttribute("aria-checked")).toBe("false");
		act(() => sw?.click());
		expect(onChange).toHaveBeenCalledWith(true);
	});

	it("does not flip when read-only", () => {
		const onChange = vi.fn();
		render(h, ToggleCell, {
			property: def({ valueType: ValueType.Boolean }),
			value: true,
			onChange,
			readOnly: true,
			noteId: "n1",
		});
		act(() => h.container.querySelector<HTMLButtonElement>(".bs-cell-toggle")?.click());
		expect(onChange).not.toHaveBeenCalled();
	});
});

describe("RatingCell", () => {
	let h: Harness;
	beforeEach(() => {
		h = mount();
	});
	afterEach(() => h.cleanup());

	it("renders range.max stars and sets the clicked rating", () => {
		const onChange = vi.fn();
		render(h, RatingCell, {
			property: def({ valueType: ValueType.Number, range: { min: 0, max: 5 } }),
			value: 0,
			onChange,
			noteId: "n1",
		});
		const stars = h.container.querySelectorAll<HTMLButtonElement>(".bs-cell-star");
		expect(stars.length).toBe(5);
		act(() => stars[2]?.click());
		expect(onChange).toHaveBeenCalledWith(3);
	});

	it("clears when the current top star is re-clicked", () => {
		const onChange = vi.fn();
		render(h, RatingCell, {
			property: def({ valueType: ValueType.Number, range: { min: 0, max: 5 } }),
			value: 3,
			onChange,
			noteId: "n1",
		});
		const stars = h.container.querySelectorAll<HTMLButtonElement>(".bs-cell-star");
		act(() => stars[2]?.click());
		expect(onChange).toHaveBeenCalledWith(null);
	});
});

describe("MultilineCell", () => {
	let h: Harness;
	beforeEach(() => {
		h = mount();
	});
	afterEach(() => h.cleanup());

	it("opens a textarea on click, keeps Shift+Enter as a break, and commits on Enter", () => {
		const onChange = vi.fn();
		render(h, MultilineCell, {
			property: def({ valueType: ValueType.Text }),
			value: "",
			onChange,
			noteId: "n1",
		});
		act(() => h.container.querySelector<HTMLButtonElement>(".bs-cell-multiline")?.click());
		const ta = h.container.querySelector<HTMLTextAreaElement>(".bs-cell-multiline-input");
		if (!ta) throw new Error("no textarea");
		act(() => {
			const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
			setter?.call(ta, "line one\nline two");
			ta.dispatchEvent(new Event("input", { bubbles: true }));
		});
		// Shift+Enter is a line break, not a commit.
		act(() =>
			ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true })),
		);
		expect(onChange).not.toHaveBeenCalled();
		// Plain Enter commits the draft.
		act(() => ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
		expect(onChange).toHaveBeenCalledWith("line one\nline two");
	});
});

describe("TagPicker inline create", () => {
	let h: Harness;
	beforeEach(() => {
		h = mount();
	});
	afterEach(() => h.cleanup());

	function withStore(store: DictionaryStore, node: ReactNode): ReactNode {
		return createElement(
			PropertiesContext.Provider,
			{
				value: {
					propertyStore: null as never,
					dictionaryStore: store,
					ready: true,
				},
			},
			node,
		);
	}

	it("offers Create for a novel label, persists it, and selects it", async () => {
		const setDictionary = vi.fn().mockResolvedValue(undefined);
		const store = new DictionaryStore({
			backend: { setDictionary, removeDictionary: vi.fn().mockResolvedValue(undefined) },
		});
		const dict: Dictionary = { id: "d1", name: "Status", items: [] };
		act(() => store.applySnapshot({ d1: dict }));

		const onChange = vi.fn();
		act(() => {
			h.root.render(
				withStore(
					store,
					createElement(TagCell, {
						property: def({
							valueType: ValueType.Text,
							vocabulary: { dictionaryId: "d1" },
							count: { min: 0, max: 1 },
						}),
						value: null,
						onChange,
						noteId: "n1",
					}),
				),
			);
		});

		act(() => h.container.querySelector<HTMLButtonElement>(".bs-cell-tag-trigger")?.click());
		const input = document.querySelector<HTMLInputElement>(".bs-cell-pop-input");
		if (!input) throw new Error("no tag search");
		act(() => {
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
			setter?.call(input, "Blocked");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});

		const createRow = document.querySelector<HTMLButtonElement>(".bs-cell-pop-row--create");
		expect(createRow?.textContent).toContain("Blocked");
		act(() => createRow?.click());

		// Persisted a dictionary that now contains the new item…
		expect(setDictionary).toHaveBeenCalledTimes(1);
		const persisted = setDictionary.mock.calls[0]?.[0] as Dictionary;
		expect(persisted.items.map((i) => i.label)).toContain("Blocked");
		// …and selected it (scalar emit = the new item id).
		expect(onChange).toHaveBeenCalledTimes(1);
		const emitted = onChange.mock.calls[0]?.[0];
		expect(emitted).toBe(persisted.items[0]?.id);
	});
});

describe("autoEdit — keyboard begin-editing signal (12.4)", () => {
	let h: Harness;
	beforeEach(() => {
		h = mount();
	});
	afterEach(() => h.cleanup());

	it("opens a PlainCell's inline input on the rising edge and acks it", () => {
		const onAutoEditHandled = vi.fn();
		render(h, PlainCell, {
			property: def({ valueType: ValueType.Text }),
			value: "hi",
			onChange: vi.fn(),
			noteId: "n1",
			autoEdit: true,
			onAutoEditHandled,
		});
		// The resting button is replaced by the inline editor without a click.
		expect(h.container.querySelector(".bs-cell-plain-input")).not.toBeNull();
		expect(onAutoEditHandled).toHaveBeenCalledTimes(1);
	});

	it("ignores autoEdit on a read-only cell (stays resting, no ack)", () => {
		const onAutoEditHandled = vi.fn();
		render(h, PlainCell, {
			property: def({ valueType: ValueType.Text }),
			value: "hi",
			onChange: vi.fn(),
			readOnly: true,
			noteId: "n1",
			autoEdit: true,
			onAutoEditHandled,
		});
		expect(h.container.querySelector(".bs-cell-plain-input")).toBeNull();
		expect(h.container.querySelector(".bs-cell-plain")).not.toBeNull();
		expect(onAutoEditHandled).not.toHaveBeenCalled();
	});

	it("does not open while the signal stays low", () => {
		render(h, PlainCell, {
			property: def({ valueType: ValueType.Text }),
			value: "hi",
			onChange: vi.fn(),
			noteId: "n1",
			autoEdit: false,
		});
		expect(h.container.querySelector(".bs-cell-plain-input")).toBeNull();
	});

	it("opens a MultilineCell's textarea on the rising edge", () => {
		render(h, MultilineCell, {
			property: def({ valueType: ValueType.Text }),
			value: "",
			onChange: vi.fn(),
			noteId: "n1",
			autoEdit: true,
		});
		expect(h.container.querySelector(".bs-cell-multiline-input")).not.toBeNull();
	});

	it("opens a popover-backed cell (DateCell) on the rising edge and acks it", () => {
		const onAutoEditHandled = vi.fn();
		render(h, DateCell, {
			property: def({ valueType: ValueType.Date }),
			value: null,
			onChange: vi.fn(),
			noteId: "n1",
			autoEdit: true,
			onAutoEditHandled,
		});
		const trigger = h.container.querySelector(".bs-cell-date-trigger");
		expect(trigger?.getAttribute("aria-expanded")).toBe("true");
		expect(document.querySelector(".bs-cell-date-pop")).not.toBeNull();
		expect(onAutoEditHandled).toHaveBeenCalledTimes(1);
	});

	it("localises the calendar month-step buttons through the labels seam", () => {
		act(() => {
			h.root.render(
				createElement(
					PropertiesContext.Provider,
					{
						value: {
							propertyStore: null as never,
							dictionaryStore: null as never,
							ready: true,
							labels: {
								...DEFAULT_PROPERTY_UI_LABELS,
								datePrevMonth: "Mois précédent",
								dateNextMonth: "Mois suivant",
							},
						},
					},
					createElement(DateCell, {
						property: def({ valueType: ValueType.Date }),
						value: null,
						onChange: vi.fn(),
						noteId: "n1",
						autoEdit: true,
					}),
				),
			);
		});
		const arrows = [...document.querySelectorAll(".bs-cell-cal-arrow")].map((b) =>
			b.getAttribute("aria-label"),
		);
		expect(arrows).toEqual(["Mois précédent", "Mois suivant"]);
	});

	it("falls back to English month-step labels when the seam omits them", () => {
		render(h, DateCell, {
			property: def({ valueType: ValueType.Date }),
			value: null,
			onChange: vi.fn(),
			noteId: "n1",
			autoEdit: true,
		});
		const arrows = [...document.querySelectorAll(".bs-cell-cal-arrow")].map((b) =>
			b.getAttribute("aria-label"),
		);
		expect(arrows).toEqual(["Previous month", "Next month"]);
	});

	it("keeps a read-only popover cell closed under autoEdit", () => {
		const onAutoEditHandled = vi.fn();
		render(h, DateCell, {
			property: def({ valueType: ValueType.Date }),
			value: null,
			onChange: vi.fn(),
			readOnly: true,
			noteId: "n1",
			autoEdit: true,
			onAutoEditHandled,
		});
		expect(h.container.querySelector(".bs-cell-date-trigger")?.getAttribute("aria-expanded")).toBe(
			"false",
		);
		expect(document.querySelector(".bs-cell-date-pop")).toBeNull();
		expect(onAutoEditHandled).not.toHaveBeenCalled();
	});

	it("opens a ProgressBarCell editor on the rising edge", () => {
		render(h, ProgressBarCell, {
			property: def({ valueType: ValueType.Number, range: { min: 0, max: 100 } }),
			value: 40,
			onChange: vi.fn(),
			noteId: "n1",
			autoEdit: true,
		});
		expect(h.container.querySelector(".bs-cell-input")).not.toBeNull();
	});

	it("flips a Boolean cell on autoEdit and acks (the flip is its 'edit')", () => {
		const onChange = vi.fn();
		const onAutoEditHandled = vi.fn();
		render(h, ToggleCell, {
			property: def({ valueType: ValueType.Boolean }),
			value: false,
			onChange,
			noteId: "n1",
			autoEdit: true,
			onAutoEditHandled,
		});
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith(true);
		expect(onAutoEditHandled).toHaveBeenCalledTimes(1);
	});

	it("fires the action ONCE per rising edge — no re-fire while the signal stays latched", () => {
		const onChange = vi.fn();
		const base = {
			property: def({ valueType: ValueType.Boolean }),
			value: false,
			onChange,
			noteId: "n1",
		};
		// Rising edge → one flip.
		render(h, ToggleCell, { ...base, autoEdit: true });
		expect(onChange).toHaveBeenCalledTimes(1);
		// Re-render with the signal still latched → must NOT flip again (a mutating
		// action would otherwise toggle on every commit).
		render(h, ToggleCell, { ...base, autoEdit: true });
		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it("re-fires after the latch drops (a re-press re-edits the same cell)", () => {
		const onChange = vi.fn();
		const base = {
			property: def({ valueType: ValueType.Boolean }),
			value: false,
			onChange,
			noteId: "n1",
		};
		render(h, ToggleCell, { ...base, autoEdit: true }); // press
		render(h, ToggleCell, { ...base, autoEdit: false }); // latch drops (ack cleared it)
		render(h, ToggleCell, { ...base, autoEdit: true }); // re-press
		expect(onChange).toHaveBeenCalledTimes(2);
	});
});
