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

import { type Dictionary, type PropertyDef, ValueType } from "@brainstorm-os/sdk-types";
import { BrainstormMenuProvider, getActiveMenuStore } from "@brainstorm-os/sdk/menus";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SnapshotShape = {
	properties: Record<string, PropertyDef>;
	dictionaries: Record<string, Dictionary>;
	usage: {
		propertyUsage: Record<string, number>;
		dictionaryUsage: Record<string, number>;
	};
};

const emptySnapshot = (): SnapshotShape => ({
	properties: {},
	dictionaries: {},
	usage: { propertyUsage: {}, dictionaryUsage: {} },
});

const snapshotMock = vi.hoisted(() => ({
	current: {
		properties: {},
		dictionaries: {},
		usage: { propertyUsage: {}, dictionaryUsage: {} },
	} as SnapshotShape,
}));

vi.mock("./use-properties-snapshot", () => ({
	usePropertiesSnapshot: () => snapshotMock.current,
}));

import { DataSection } from "./data-section";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no ResizeObserver; the virtualized property list observes its
// scroller for the live viewport height.
class ResizeObserverStub {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverStub;

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
		snapshotMock.current = emptySnapshot();
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

/**
 * UsagePill zero-count affordance (327 audit): "some properties show a usage
 * count, others nothing" — the pill returned `null` at zero, so an unused
 * property was indistinguishable from an uncounted one. It now always
 * renders: a quiet "Not used" face at zero, the numeric pill otherwise, for
 * both property rows and dictionary-item rows.
 */
describe("DataSection — usage pill zero-count affordance (327 audit)", () => {
	let host: HTMLDivElement;
	let root: Root;

	const textDef = (key: string, name: string): PropertyDef => ({
		key,
		name,
		icon: null,
		valueType: ValueType.Text,
	});
	const DEF_USED = textDef("prop_used", "Owner");
	const DEF_UNUSED = textDef("prop_unused", "Zebra");
	const DEF_SELECT: PropertyDef = {
		...textDef("prop_status", "Status"),
		vocabulary: { dictionaryId: "dict_1" },
	};
	const DICT: Dictionary = {
		id: "dict_1",
		name: "Status",
		items: [
			{ id: "item_used", label: "Open", icon: null, sortIndex: 0 },
			{ id: "item_unused", label: "Closed", icon: null, sortIndex: 1 },
		],
	};

	beforeEach(() => {
		snapshotMock.current = {
			properties: {
				[DEF_USED.key]: DEF_USED,
				[DEF_UNUSED.key]: DEF_UNUSED,
				[DEF_SELECT.key]: DEF_SELECT,
			},
			dictionaries: { dict_1: DICT },
			usage: {
				propertyUsage: { prop_used: 3, prop_status: 1 },
				dictionaryUsage: { item_used: 2 },
			},
		} satisfies SnapshotShape;
		(window as unknown as { brainstorm: unknown }).brainstorm = {
			properties: {
				setProperty: vi.fn(),
				setDictionary: vi.fn(),
				removeProperty: vi.fn(),
				entityTypes: vi.fn().mockResolvedValue([]),
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
	});

	afterEach(() => {
		act(() => root.unmount());
		host.remove();
		snapshotMock.current = emptySnapshot();
		(window as unknown as { brainstorm?: unknown }).brainstorm = undefined;
	});

	const pillFor = (name: string): HTMLElement | null => {
		const rows = [...document.querySelectorAll(".data__row")];
		const row = rows.find((r) => r.querySelector(".data__row-name")?.textContent === name);
		return row?.querySelector<HTMLElement>(".data__usage-pill") ?? null;
	};

	it("a counted property keeps the numeric pill", () => {
		const pill = pillFor("Owner");
		expect(pill?.textContent).toBe("3");
		expect(pill?.classList.contains("data__usage-pill--unused")).toBe(false);
		expect(pill?.getAttribute("aria-label")).toBe("Used by 3 objects");
	});

	it("a zero-count property renders the Not used pill instead of nothing", () => {
		const pill = pillFor("Zebra");
		expect(pill).not.toBeNull();
		expect(pill?.textContent).toBe("Not used");
		expect(pill?.classList.contains("data__usage-pill--unused")).toBe(true);
		expect(pill?.getAttribute("aria-label")).toBe("Used by 0 objects");
	});

	it("dictionary-item rows get the same zero-count treatment", async () => {
		// Open the Status property's constructor — its vocab list carries a
		// usage pill per dictionary item.
		const row = [...document.querySelectorAll(".data__row")].find(
			(r) => r.querySelector(".data__row-name")?.textContent === "Status",
		);
		const trigger = row?.querySelector<HTMLButtonElement>(".data__row-trigger");
		expect(trigger).not.toBeNull();
		await act(async () => {
			trigger?.click();
		});

		const pills = [...document.querySelectorAll<HTMLElement>(".data__vocab-list .data__usage-pill")];
		expect(pills).toHaveLength(2);
		const used = pills.find((p) => p.textContent === "2");
		const unused = pills.find((p) => p.textContent === "Not used");
		expect(used?.classList.contains("data__usage-pill--unused")).toBe(false);
		expect(used?.getAttribute("aria-label")).toBe("2 objects use this value");
		expect(unused?.classList.contains("data__usage-pill--unused")).toBe(true);
		expect(unused?.getAttribute("aria-label")).toBe("0 objects use this value");
	});
});
