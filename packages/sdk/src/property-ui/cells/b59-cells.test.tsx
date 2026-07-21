// @vitest-environment jsdom
/**
 * Render + interaction tests for the B5.9 cells: ProgressBarCell,
 * DateCell (natural-language popover), the formatted Text cell's
 * validation visuals, the accept-only File cells, and the stubbed Link
 * cell picker (driven off a fake `window.brainstorm.vaultEntities`).
 */

import type { CellProps, PropertyDef, VaultEntity } from "@brainstorm-os/sdk-types";
import { CARDINALITY_HARD_MAX, PropertyFormat, ValueType } from "@brainstorm-os/sdk-types";
import { type ComponentType, type ReactNode, createElement } from "react";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EntityTitleSource } from "../seams";
import { PropertiesContext } from "../use-properties";
import { DateCell } from "./date-cell";
import { FileListCell, GalleryCell } from "./file-cell";
import { FormattedPillCell } from "./formatted-cell";
import { LinkInlineCell } from "./link-cell";
import { ProgressBarCell } from "./progress-cell";

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

describe("ProgressBarCell", () => {
	let h: Harness;
	beforeEach(() => {
		h = mount();
	});
	afterEach(() => h.cleanup());

	it("fills the bar to the clamped fraction of range", () => {
		render(h, ProgressBarCell, {
			property: def({ valueType: ValueType.Number, range: { min: 0, max: 200 } }),
			value: 50,
			onChange: vi.fn(),
			noteId: "n1",
		});
		const fill = h.container.querySelector<HTMLElement>(".bs-cell-progress-fill");
		expect(fill?.style.transform).toBe("scaleX(0.25)");
		expect(h.container.querySelector(".bs-cell-progress-track")?.getAttribute("aria-valuemax")).toBe(
			"200",
		);
	});

	it("shows empty for a null value and 0% fill", () => {
		render(h, ProgressBarCell, {
			property: def({ valueType: ValueType.Number }),
			value: null,
			onChange: vi.fn(),
			noteId: "n1",
		});
		expect(h.container.querySelector<HTMLElement>(".bs-cell-progress-fill")?.style.transform).toBe(
			"scaleX(0)",
		);
	});
});

describe("DateCell", () => {
	let h: Harness;
	beforeEach(() => {
		h = mount();
	});
	afterEach(() => h.cleanup());

	it("commits a natural-language phrase through the popover", () => {
		const onChange = vi.fn();
		render(h, DateCell, {
			property: def({ valueType: ValueType.Date }),
			value: null,
			onChange,
			noteId: "n1",
		});
		act(() => {
			h.container.querySelector<HTMLButtonElement>(".bs-cell-date-trigger")?.click();
		});
		const input = document.querySelector<HTMLInputElement>(".bs-cell-pop-input");
		if (!input) throw new Error("no date input");
		act(() => {
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
			setter?.call(input, "tomorrow");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		act(() => {
			document.querySelector<HTMLButtonElement>(".bs-cell-date-set")?.click();
		});
		expect(onChange).toHaveBeenCalledTimes(1);
		const arg = onChange.mock.calls[0]?.[0] as { at: number } | null;
		expect(typeof arg?.at).toBe("number");
	});
});

describe("FormattedPillCell validation visuals", () => {
	let h: Harness;
	beforeEach(() => {
		h = mount();
	});
	afterEach(() => h.cleanup());

	it("adds the invalid class + tooltip for a bad email", () => {
		render(h, FormattedPillCell, {
			property: def({ valueType: ValueType.Text, format: PropertyFormat.Email }),
			value: "not-an-email",
			onChange: vi.fn(),
			noteId: "n1",
		});
		const btn = h.container.querySelector<HTMLButtonElement>(".bs-cell-pill--invalid");
		expect(btn).not.toBeNull();
		expect(btn?.getAttribute("title")).toBe("Not a valid email address");
		expect(btn?.getAttribute("aria-invalid")).toBe("true");
	});

	it("no invalid chrome for a valid URL or plain text", () => {
		render(h, FormattedPillCell, {
			property: def({ valueType: ValueType.Text, format: PropertyFormat.Url }),
			value: "https://example.com",
			onChange: vi.fn(),
			noteId: "n1",
		});
		expect(h.container.querySelector(".bs-cell-pill--invalid")).toBeNull();
	});
});

describe("File cells (accept-only)", () => {
	let h: Harness;
	beforeEach(() => {
		h = mount();
	});
	afterEach(() => h.cleanup());

	it("renders the uploads-pending caption and an empty state", () => {
		render(h, FileListCell, {
			property: def({
				valueType: ValueType.EntityRef,
				count: { min: 0, max: CARDINALITY_HARD_MAX },
			}),
			value: [],
			onChange: vi.fn(),
			noteId: "n1",
		});
		expect(h.container.querySelector(".bs-cell-file-pending")?.textContent).toContain("uploads land");
		expect(h.container.querySelector(".bs-cell-file-empty")).not.toBeNull();
	});

	it("a drop is accepted without mutating the value", () => {
		const onChange = vi.fn();
		render(h, GalleryCell, {
			property: def({ valueType: ValueType.EntityRef }),
			value: null,
			onChange,
			noteId: "n1",
		});
		const zone = h.container.querySelector(".bs-cell-file");
		act(() => {
			zone?.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
		});
		expect(onChange).not.toHaveBeenCalled();
	});
});

describe("LinkInlineCell (stubbed note picker)", () => {
	let h: Harness;

	const ENTITIES: VaultEntity[] = [
		{
			id: "n_aaa",
			type: "Note",
			properties: { title: "Roadmap" },
			createdAt: 0,
			updatedAt: 0,
			deletedAt: null,
			ownerAppId: "io.brainstorm.notes",
		},
		{
			id: "person_x",
			type: "Person",
			properties: { name: "Ada" },
			createdAt: 0,
			updatedAt: 0,
			deletedAt: null,
			ownerAppId: "x",
		},
	];

	// A synchronous EntityTitleSource over the fixture — the seam Notes
	// wires its real `entity-title-index` singleton into.
	const titleSource: EntityTitleSource = {
		subscribe: () => () => undefined,
		snapshotTick: () => 1,
		list: () => ENTITIES,
		titleOf: (id) => ENTITIES.find((e) => e.id === id)?.properties.title as string | undefined,
		displayTitle: (e) => (e.properties.title ?? e.properties.name ?? e.id) as string,
	};

	function withSeam(node: ReactNode): ReactNode {
		return createElement(
			PropertiesContext.Provider,
			{
				value: {
					propertyStore: null as never,
					dictionaryStore: null as never,
					ready: true,
					entityTitleSource: titleSource,
				},
			},
			node,
		);
	}

	beforeEach(() => {
		h = mount();
	});
	afterEach(() => h.cleanup());

	it("lists only note:* ids and emits the picked id (scalar)", async () => {
		const onChange = vi.fn();
		act(() => {
			h.root.render(
				withSeam(
					createElement(LinkInlineCell, {
						property: def({ valueType: ValueType.EntityRef, count: { min: 0, max: 1 } }),
						value: null,
						onChange,
						noteId: "n_self",
					}),
				),
			);
		});
		act(() => {
			h.container.querySelector<HTMLButtonElement>(".bs-cell-link-trigger")?.click();
		});
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		const rows = document.querySelectorAll<HTMLButtonElement>(".bs-cell-pop-row");
		expect(rows.length).toBe(1); // person_x filtered out
		expect(rows[0]?.textContent).toContain("Roadmap");
		act(() => rows[0]?.click());
		expect(onChange).toHaveBeenCalledWith("n_aaa");
	});

	it("scopes by allowedTypes when set (link to People, not notes)", async () => {
		const onChange = vi.fn();
		act(() => {
			h.root.render(
				withSeam(
					createElement(LinkInlineCell, {
						property: def({
							valueType: ValueType.EntityRef,
							count: { min: 0, max: 1 },
							allowedTypes: ["Person"],
						}),
						value: null,
						onChange,
						noteId: "n_self",
					}),
				),
			);
		});
		act(() => {
			h.container.querySelector<HTMLButtonElement>(".bs-cell-link-trigger")?.click();
		});
		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		const rows = document.querySelectorAll<HTMLButtonElement>(".bs-cell-pop-row");
		expect(rows.length).toBe(1); // n_aaa (a Note) filtered out
		expect(rows[0]?.textContent).toContain("Ada");
		act(() => rows[0]?.click());
		expect(onChange).toHaveBeenCalledWith("person_x");
	});
});
