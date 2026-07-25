// @vitest-environment jsdom
/**
 * 8.10.2 — the fill surface renders through the shared 8.3 pipeline, and
 * a grid form places its fields.
 *
 * The point of the swap is not cosmetic: the fill pane used to run its
 * own field loop, so it could not get grid placement or per-cell
 * subscriptions without re-implementing both. These pin the observable
 * consequences — the layout root carries the mode, cells carry their
 * grid placement, and the reading order stays row-major so `Tab` follows
 * the visual rows.
 */

import { LayoutCellKind, LayoutMode } from "@brainstorm-os/sdk-types";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { FormDesignerApp } from "./app";

const LAYOUT_TYPE = "brainstorm/Layout/v1";

function gridFormRow() {
	return {
		id: "ent_form_grid",
		type: LAYOUT_TYPE,
		createdAt: 1,
		updatedAt: 1,
		deletedAt: null,
		properties: {
			name: "Two-up form",
			targetType: "brainstorm/Object/v1",
			mode: LayoutMode.Grid,
			columns: 2,
			cells: [
				{
					kind: LayoutCellKind.Property,
					id: "field-0",
					property: "first",
					grid: { col: 1, row: 1 },
				},
				{
					kind: LayoutCellKind.Property,
					id: "field-1",
					property: "second",
					grid: { col: 2, row: 1 },
				},
				{
					kind: LayoutCellKind.Property,
					id: "field-2",
					property: "third",
					grid: { col: 1, row: 2 },
				},
			],
		},
	};
}

function installShell(): void {
	(window as { brainstorm?: unknown }).brainstorm = {
		on: (_event: string, handler: () => void) => {
			handler();
			return { unsubscribe: () => {} };
		},
		services: {
			vaultEntities: {
				list: () => Promise.resolve({ entities: [gridFormRow()], links: [] }),
				onChange: () => ({ unsubscribe: () => {} }),
			},
			entities: {
				get: vi.fn(() => Promise.resolve(null)),
				create: vi.fn(() => Promise.resolve(null)),
				update: vi.fn(() => Promise.resolve(null)),
				delete: vi.fn(() => Promise.resolve()),
				query: vi.fn(() => Promise.resolve([])),
			},
		},
	};
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function renderApp(): Promise<HTMLDivElement> {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	await act(async () => root?.render(<FormDesignerApp />));
	await act(async () => {
		await Promise.resolve();
	});
	return container;
}

function clickByText(el: HTMLElement, selector: string, text: string): void {
	const btn = [...el.querySelectorAll<HTMLButtonElement>(selector)].find(
		(b) => b.textContent?.trim() === text,
	);
	if (!btn) throw new Error(`no ${selector} with text "${text}"`);
	btn.click();
}

async function openFill(el: HTMLElement): Promise<void> {
	await act(async () => el.querySelector<HTMLButtonElement>(".fd-sidebar__item")?.click());
	await act(async () => clickByText(el, ".bs-segmented__tab", "Fill"));
	await act(async () => {
		await Promise.resolve();
	});
}

beforeEach(() => {
	installShell();
});

afterEach(() => {
	act(() => root?.unmount());
	container?.remove();
	container = null;
	root = null;
	(window as { brainstorm?: unknown }).brainstorm = undefined;
});

describe("form fill renders through the 8.3 pipeline", () => {
	it("the fill surface IS a LayoutView, not a bespoke field loop", async () => {
		const el = await renderApp();
		await openFill(el);
		expect(el.querySelector(".fd-fill__layout")).not.toBeNull();
		expect(el.querySelectorAll("[data-cell-id]").length).toBe(3);
	});

	it("a grid form paints in grid mode with each field placed", async () => {
		const el = await renderApp();
		await openFill(el);
		const layout = el.querySelector<HTMLElement>(".fd-fill__layout");
		expect(layout?.getAttribute("data-layout-mode")).toBe(LayoutMode.Grid);

		const second = el.querySelector<HTMLElement>('[data-cell-id="field-1"]');
		expect(second?.style.gridColumn).toBe("2");
		expect(second?.style.gridRow).toBe("1");

		const third = el.querySelector<HTMLElement>('[data-cell-id="field-2"]');
		expect(third?.style.gridRow).toBe("2");
	});

	it("DOM order stays row-major, so Tab follows the visual rows", async () => {
		const el = await renderApp();
		await openFill(el);
		const ids = [...el.querySelectorAll("[data-cell-id]")].map((n) => n.getAttribute("data-cell-id"));
		expect(ids).toEqual(["field-0", "field-1", "field-2"]);
	});

	it("each field keeps its label + required marker through the renderCell seam", async () => {
		const el = await renderApp();
		await openFill(el);
		const rows = el.querySelectorAll(".fd-fill__row");
		expect(rows).toHaveLength(3);
		expect(rows[0]?.querySelector(".fd-label")?.textContent).toContain("first");
		expect(rows[0]?.querySelector(".fd-required")).not.toBeNull();
	});

	it("a field with no property catalog is still fillable (the missing-cell seam)", async () => {
		const el = await renderApp();
		await openFill(el);
		// This shell mock ships no properties service, so nothing resolves a
		// PropertyDef — the form must not degrade to a read-only placeholder.
		expect(el.querySelectorAll(".fd-fill__row .fd-input")).toHaveLength(3);
		expect(el.querySelector("[data-placeholder]")).toBeNull();
	});
});
