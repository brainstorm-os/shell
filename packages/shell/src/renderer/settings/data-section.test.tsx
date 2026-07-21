// @vitest-environment jsdom
/**
 * KBN-G-roles — Data-section property constructor radiogroups.
 *
 * The roving/arrow/role machinery lives in the SDK `useCompositeKeyboard`
 * tests; this file pins the two radiogroups wired into `data-section.tsx`'s
 * constructor: the kind grid (a 1D radio set over the responsive tile grid)
 * and the text-format row. Both should expose `radiogroup`/`radio` roles with
 * a single checked item that arrow keys move.
 */

import { BrainstormMenuProvider, getActiveMenuStore } from "@brainstorm-os/sdk/menus";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./use-properties-snapshot", () => ({
	usePropertiesSnapshot: () => ({
		properties: {},
		dictionaries: {},
		usage: { propertyUsage: {}, dictionaryUsage: {} },
	}),
}));

import { DataSection } from "./data-section";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type RowClick = (item: unknown, e: unknown, ctx: unknown) => void;

function dispatchKey(target: EventTarget, key: string): void {
	act(() => {
		target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
	});
}

describe("DataSection — KBN-G-roles constructor radiogroups", () => {
	let host: HTMLDivElement;
	let root: Root;
	let setProperty: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		setProperty = vi.fn();
		(window as unknown as { brainstorm: unknown }).brainstorm = {
			properties: {
				setProperty,
				setDictionary: vi.fn(),
				removeProperty: vi.fn(),
				entityTypes: vi.fn().mockResolvedValue(["brainstorm/Person/v1", "brainstorm/Task/v1"]),
			},
		};
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		act(() =>
			root.render(
				<BrainstormMenuProvider>
					<DataSection />
				</BrainstormMenuProvider>,
			),
		);
		// Open the constructor (create mode) via the "New property" trigger.
		const add = [...document.querySelectorAll("button")].find(
			(b) => b.textContent === "New property",
		);
		act(() => add?.click());
	});

	afterEach(() => {
		act(() => root.unmount());
		host.remove();
		(window as unknown as { brainstorm?: unknown }).brainstorm = undefined;
	});

	// <Popover> portals to document.body.
	const groups = () => [...document.querySelectorAll('[role="radiogroup"]')] as HTMLElement[];
	const kindGroup = () => document.querySelector('[aria-label="Kind"]') as HTMLElement;
	const formatGroup = () => document.querySelector('[aria-label="Format"]') as HTMLElement;
	const checked = (group: HTMLElement) =>
		group.querySelector('[role="radio"][aria-checked="true"]') as HTMLElement | null;

	it("renders both radiogroups (kind + format) with one checked radio each", () => {
		expect(groups()).toHaveLength(2);
		expect(checked(kindGroup())?.textContent).toContain("Text");
		expect(checked(formatGroup())?.textContent).toBe("Plain");
	});

	it("ArrowDown moves the kind selection to the next tile", () => {
		expect(checked(kindGroup())?.textContent).toContain("Text");
		dispatchKey(kindGroup(), "ArrowDown");
		expect(checked(kindGroup())?.textContent).toContain("Number");
	});

	it("ArrowRight moves the text-format selection", () => {
		expect(checked(formatGroup())?.textContent).toBe("Plain");
		dispatchKey(formatGroup(), "ArrowRight");
		expect(checked(formatGroup())?.textContent).toBe("URL");
	});

	it("selecting a non-Text kind hides the format radiogroup", () => {
		// Boolean is two tiles down from Text (Text → Number → Boolean).
		dispatchKey(kindGroup(), "ArrowDown");
		dispatchKey(kindGroup(), "ArrowDown");
		expect(checked(kindGroup())?.textContent).toContain("Boolean");
		expect(formatGroup()).toBeNull();
		expect(groups()).toHaveLength(1);
	});

	it("Link kind reveals the allowed-types picker and saves the scoped types", async () => {
		// Link is the last tile: Text→Number→Boolean→Date→Select→File→Link.
		for (let i = 0; i < 6; i++) dispatchKey(kindGroup(), "ArrowDown");
		expect(checked(kindGroup())?.textContent).toContain("Link");

		// The picker fetches entity types asynchronously — flush the microtask.
		await act(async () => undefined);
		// The allowed-types picker is now a multi-select menu: open it and read
		// the toggle rows the runtime is rendering.
		const trigger = document.querySelector(".data__type-select") as HTMLButtonElement;
		expect(trigger).not.toBeNull();
		act(() => trigger.click());
		const menu = () => {
			const store = getActiveMenuStore();
			const open = store?.getAll().find((m) => m.id.startsWith("bs/multi-select-menu"));
			return { store, open };
		};
		const { store, open } = menu();
		const rows = (open?.param.data as { rows: { id: string; label: string }[] }).rows;
		expect(rows.map((r) => r.label)).toEqual(expect.arrayContaining(["Persons", "Tasks"]));

		// Name the property and scope it to Person.
		const nameInput = document.querySelector(".data__form-name") as HTMLInputElement;
		const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
		act(() => {
			setValue?.call(nameInput, "Owner");
			nameInput.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const personRow = rows.find((r) => r.label === "Persons");
		const ctx = { updateData: (patch: unknown) => store?.updateData(open?.id ?? "", patch) };
		const rowSpec = (open?.config.body as { rows: ReadonlyArray<{ onClick: RowClick }> }).rows[0];
		act(() => rowSpec?.onClick(personRow, new MouseEvent("click"), ctx));

		const create = [...document.querySelectorAll("button")].find((b) => b.textContent === "Create");
		await act(async () => {
			create?.click();
		});

		expect(setProperty).toHaveBeenCalledTimes(1);
		const def = setProperty.mock.calls[0]?.[0];
		expect(def.name).toBe("Owner");
		expect(def.valueType).toBe("entityRef");
		expect(def.allowedTypes).toEqual(["brainstorm/Person/v1"]);
	});

	it("Select kind: the vocab colour picker opens the shared anchored menu and applies a colour", () => {
		// Select is the 5th tile: Text→Number→Boolean→Date→Select.
		for (let i = 0; i < 4; i++) dispatchKey(kindGroup(), "ArrowDown");
		expect(checked(kindGroup())?.textContent).toContain("Select");

		// Add a vocabulary item so a row (with its colour button) renders.
		const draft = document.querySelector(".data__vocab-input--draft") as HTMLInputElement;
		const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
		act(() => {
			setValue?.call(draft, "Open");
			draft.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const addBtn = [...document.querySelectorAll(".data__vocab-add button")].find((b) =>
			b.textContent?.includes("Add"),
		) as HTMLButtonElement;
		act(() => addBtn.click());

		// No bespoke `role="menu"` div should exist — the picker is the runtime.
		const colorBtn = document.querySelector(".data__vocab-color-btn") as HTMLButtonElement;
		expect(colorBtn).not.toBeNull();
		act(() => colorBtn.click());
		expect(document.querySelector(".data__vocab-color-popover")).toBeNull();

		const open = getActiveMenuStore()
			?.getAll()
			.find((m) => m.id.startsWith("bs/context-menu"));
		expect(open).toBeTruthy();
		const items = (open?.param.data as { items: { label: string; onSelect?: () => void }[] }).items;
		// One row per palette entry (no-colour + 8 hues).
		expect(items).toHaveLength(9);
		expect(items.map((i) => i.label)).toEqual(expect.arrayContaining(["No color", "Red", "Blue"]));

		// Picking a colour writes it onto the vocab item's dot.
		const blue = items.find((i) => i.label === "Blue");
		act(() => blue?.onSelect?.());
		const dot = document.querySelector(".data__vocab-color-dot") as HTMLElement;
		expect(dot.style.background).toContain("rgb(37, 99, 235)");
	});
});
