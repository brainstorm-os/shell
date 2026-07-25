// @vitest-environment jsdom
/**
 * The six chrome cells (Stage 8.4), rendered through `<LayoutView>`'s
 * seam — i.e. exactly how a host wires them, not in isolation.
 */

import {
	type ChromeCell,
	ChromeKind,
	type LayoutCell,
	LayoutCellKind,
	type LayoutDef,
	LayoutMode,
} from "@brainstorm-os/sdk-types";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import type { EntityRow } from "../in-memory-entities";
import { LayoutView } from "../layout-view/LayoutView";
import { staticLayoutValueSource } from "../layout-view/value-source";
import { chromeSeam } from "./ChromeCells";
import { ChromeActionId, ChromeAlignment, type ChromeHost } from "./contract";

const entity: EntityRow = {
	id: "ent_1",
	type: "io.example/Person/v1",
	properties: {},
	createdAt: 0,
	updatedAt: 0,
	deletedAt: null,
};

const chrome = (chromeKind: ChromeKind, options?: Record<string, unknown>): LayoutCell =>
	({
		id: "c",
		kind: LayoutCellKind.Chrome,
		chrome: chromeKind,
		...(options ? { options } : {}),
	}) as ChromeCell;

const def = (cells: LayoutCell[]): LayoutDef => ({
	mode: LayoutMode.Stacked,
	scope: { kind: "type", target: "io.example/Person/v1" },
	context: null,
	cells,
});

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

describe("chrome cells", () => {
	let harness: Harness;
	beforeEach(() => {
		harness = mount();
	});
	afterEach(() => harness.cleanup());

	function render(cell: LayoutCell, host: ChromeHost): void {
		act(() => {
			harness.root.render(
				<LayoutView
					layout={def([cell])}
					entity={entity}
					propertyDef={() => undefined}
					values={staticLayoutValueSource({})}
					seams={{ renderChrome: chromeSeam(host) }}
				/>,
			);
		});
	}

	it("actionBar renders the host's actions and reports the clicked button as the anchor", () => {
		const onSelect = vi.fn();
		render(chrome(ChromeKind.ActionBar), {
			entity,
			actions: [{ id: ChromeActionId.Open, label: "Open", onSelect }],
		});
		const button = harness.container.querySelector<HTMLButtonElement>('[data-action-id="open"]');
		expect(button?.getAttribute("aria-label")).toBe("Open");
		act(() => button?.click());
		expect(onSelect).toHaveBeenCalledWith(button);
	});

	it("actionBar honours the layout's button narrowing + order", () => {
		render(chrome(ChromeKind.ActionBar, { buttons: ["share", "open"] }), {
			entity,
			actions: [
				{ id: ChromeActionId.Open, label: "Open", onSelect: () => {} },
				{ id: ChromeActionId.Share, label: "Share", onSelect: () => {} },
				{ id: ChromeActionId.Delete, label: "Delete", onSelect: () => {} },
			],
		});
		const ids = Array.from(harness.container.querySelectorAll("[data-action-id]")).map((el) =>
			el.getAttribute("data-action-id"),
		);
		expect(ids).toEqual(["share", "open"]);
	});

	it("actionBar alignment reaches the DOM as a class", () => {
		render(chrome(ChromeKind.ActionBar, { alignment: ChromeAlignment.Center }), { entity });
		expect(harness.container.querySelector(".bs-chrome__action-bar")?.className).toContain(
			"bs-chrome--align-center",
		);
	});

	it("breadcrumb links every crumb that can navigate, and marks the last as current", () => {
		const onNavigate = vi.fn();
		render(chrome(ChromeKind.Breadcrumb), {
			entity,
			breadcrumb: [
				{ id: "root", label: "Vault", onNavigate },
				{ id: "here", label: "Ada" },
			],
		});
		const link = harness.container.querySelector<HTMLButtonElement>('[data-crumb-id="root"]');
		act(() => link?.click());
		expect(onNavigate).toHaveBeenCalledOnce();
		expect(
			harness.container.querySelector('[data-crumb-id="here"]')?.getAttribute("aria-current"),
		).toBe("page");
	});

	it("breadcrumb collapses a long trail at the layout's maxItems", () => {
		render(chrome(ChromeKind.Breadcrumb, { maxItems: 3 }), {
			entity,
			breadcrumb: ["a", "b", "c", "d", "e"].map((id) => ({ id, label: id })),
		});
		const labels = Array.from(harness.container.querySelectorAll(".bs-chrome__crumb")).map(
			(el) => el.textContent,
		);
		expect(labels).toEqual(["a", "…", "d", "e"]);
	});

	it("meta renders label/value pairs, narrowed by the layout's fields", () => {
		render(chrome(ChromeKind.Meta, { fields: ["modifiedAt"] }), {
			entity,
			meta: [
				{ id: "createdAt", label: "Created", value: "yesterday" },
				{ id: "modifiedAt", label: "Modified", value: "today" },
			],
		});
		const rows = harness.container.querySelectorAll(".bs-chrome__meta-row");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.textContent).toBe("Modifiedtoday");
	});

	it("entityHeader composes icon + title + actions, and can drop either", () => {
		const host: ChromeHost = {
			entity,
			title: "Ada Lovelace",
			icon: <span data-testid="icon">*</span>,
			actions: [{ id: ChromeActionId.Open, label: "Open", onSelect: () => {} }],
		};
		render(chrome(ChromeKind.EntityHeader), host);
		expect(harness.container.querySelector(".bs-chrome__entity-title")?.textContent).toBe(
			"Ada Lovelace",
		);
		expect(harness.container.querySelector('[data-testid="icon"]')).not.toBeNull();
		expect(harness.container.querySelector('[data-action-id="open"]')).not.toBeNull();

		render(chrome(ChromeKind.EntityHeader, { showIcon: false, showActions: false }), host);
		expect(harness.container.querySelector('[data-testid="icon"]')).toBeNull();
		expect(harness.container.querySelector('[data-action-id="open"]')).toBeNull();
	});

	it("windowControls renders the three controls and wires each", () => {
		const onClose = vi.fn();
		const onMinimize = vi.fn();
		const onMaximize = vi.fn();
		render(chrome(ChromeKind.WindowControls), {
			entity,
			windowControls: {
				closeLabel: "Close",
				minimizeLabel: "Minimize",
				maximizeLabel: "Maximize",
				onClose,
				onMinimize,
				onMaximize,
			},
		});
		for (const [control, spy] of [
			["minimize", onMinimize],
			["maximize", onMaximize],
			["close", onClose],
		] as const) {
			const button = harness.container.querySelector<HTMLButtonElement>(
				`[data-window-control="${control}"]`,
			);
			act(() => button?.click());
			expect(spy).toHaveBeenCalledOnce();
		}
	});

	it("windowControls renders nothing when the host has no window (a tab, say)", () => {
		render(chrome(ChromeKind.WindowControls), { entity });
		expect(harness.container.querySelector(".bs-chrome__window-controls")).toBeNull();
	});

	it("tabs renders a tablist with the active tab selected", () => {
		const onSelect = vi.fn();
		render(chrome(ChromeKind.Tabs), {
			entity,
			tabs: [
				{ id: "one", label: "One", active: true, onSelect: () => {} },
				{ id: "two", label: "Two", onSelect },
			],
		});
		expect(
			harness.container.querySelector('[data-tab-id="one"]')?.getAttribute("aria-selected"),
		).toBe("true");
		const second = harness.container.querySelector<HTMLButtonElement>('[data-tab-id="two"]');
		act(() => second?.click());
		expect(onSelect).toHaveBeenCalledOnce();
	});

	it("a chrome cell the host has no data for renders empty, never throws", () => {
		expect(() => render(chrome(ChromeKind.ActionBar), { entity })).not.toThrow();
		expect(harness.container.querySelector(".bs-chrome__action-bar")).not.toBeNull();
		expect(harness.container.querySelectorAll("[data-action-id]")).toHaveLength(0);
	});
});
