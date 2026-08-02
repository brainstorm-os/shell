// @vitest-environment jsdom
/**
 * Controlled-list typeahead menu (doc 63 / fancy-menus 0.2.0) — store-level
 * wiring. Like the rest of `menus.test.tsx`, this asserts the imperative API's
 * effect on the published `MenuStore` (the runtime doesn't paint list rows under
 * jsdom — no layout / Floating-UI), so it proves: the config is valid and
 * registers, `open` carries the right per-open param (anchor element, controlled
 * `activeIndex`, `ariaLabel`, items), `setTypeaheadActiveIndex` patches the live
 * highlight, and `close`/fail-soft behave. The rendered rows + active-row paint
 * + click-to-select + caret-focus are verified in the real shell.
 */

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getActiveMenuStore } from "./active-store";
import { BrainstormMenuProvider } from "./index";
import {
	TYPEAHEAD_MENU_ID,
	closeTypeaheadMenu,
	openTypeaheadMenu,
	setTypeaheadActiveIndex,
	typeaheadMenuConfig,
} from "./typeahead-menu";

const ITEMS = [
	{ id: "h1", label: "Heading 1", description: "Big section title" },
	{ id: "h2", label: "Heading 2" },
	{ id: "quote", label: "Quote" },
];

function openParam() {
	return getActiveMenuStore()
		?.getAll()
		.find((m) => m.id === TYPEAHEAD_MENU_ID)?.param as
		| { element?: Element; activeIndex?: number; ariaLabel?: string; data?: { items?: unknown[] } }
		| undefined;
}

describe("typeahead-menu config", () => {
	it("is a valid controlled-list config: no focus, host-owned keyboard, no dimmer", () => {
		expect(typeaheadMenuConfig.body.kind).toBe("list");
		// focusOnMount:false + KeyboardNavigation.None are the controlled-list keystone.
		expect((typeaheadMenuConfig.body as { focusOnMount?: boolean }).focusOnMount).toBe(false);
		expect(typeaheadMenuConfig.keyboard?.navigation).toBe("none");
		expect(typeaheadMenuConfig.chrome?.dimmer).toBe("none");
	});

	it("routes section items to the Section row and everything else to the Item row (first match wins)", () => {
		const rows = (
			typeaheadMenuConfig.body as { rows?: { kind: string; match?: (i: unknown) => boolean }[] }
		).rows;
		expect(rows?.map((r) => r.kind)).toEqual(["section", "item"]);
		const sectionRow = rows?.[0];
		expect(sectionRow?.match?.({ id: "s", label: "Basic blocks", section: true })).toBe(true);
		expect(sectionRow?.match?.({ id: "h1", label: "Heading 1" })).toBe(false);
	});
});

describe("openTypeaheadMenu (controlled-list)", () => {
	let host: HTMLDivElement;
	let root: Root;
	let anchor: HTMLElement;

	beforeEach(() => {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		anchor = document.createElement("p");
		document.body.appendChild(anchor);
		act(() => {
			root.render(
				<BrainstormMenuProvider>
					<div />
				</BrainstormMenuProvider>,
			);
		});
	});
	afterEach(() => {
		act(() => closeTypeaheadMenu());
		act(() => root.unmount());
		host.remove();
		anchor.remove();
	});

	it("fails soft when no provider is mounted", () => {
		act(() => root.unmount());
		expect(
			openTypeaheadMenu({
				items: ITEMS,
				anchor,
				activeIndex: 0,
				ariaLabel: "Slash commands",
				onSelect: () => undefined,
			}),
		).toBe(false);
	});

	it("registers + opens with the anchor element, controlled activeIndex, label, and items", () => {
		act(() => {
			openTypeaheadMenu({
				items: ITEMS,
				anchor,
				activeIndex: 1,
				ariaLabel: "Slash commands",
				onSelect: () => undefined,
			});
		});
		const store = getActiveMenuStore();
		expect(store?.getConfig(TYPEAHEAD_MENU_ID)).toBeTruthy();
		expect(store?.isOpen(TYPEAHEAD_MENU_ID)).toBe(true);

		const param = openParam();
		expect(param?.element).toBe(anchor);
		expect(param?.activeIndex).toBe(1);
		expect(param?.ariaLabel).toBe("Slash commands");
		expect(param?.data?.items).toHaveLength(3);
	});

	it("anchors to a caret rect when `rect` is given (mention / transclusion)", () => {
		const rect = {
			x: 12,
			y: 40,
			top: 40,
			bottom: 58,
			left: 12,
			right: 12,
			width: 0,
			height: 18,
		} as DOMRect;
		act(() => {
			openTypeaheadMenu({
				items: ITEMS,
				rect,
				activeIndex: 0,
				ariaLabel: "Mentions",
				onSelect: () => undefined,
			});
		});
		const param = openParam() as { rect?: DOMRect; element?: Element };
		expect(param.rect).toBe(rect);
		expect(param.element).toBeUndefined();
	});

	it("patches the live highlight via setTypeaheadActiveIndex", () => {
		act(() => {
			openTypeaheadMenu({
				items: ITEMS,
				anchor,
				activeIndex: 0,
				ariaLabel: "Slash commands",
				onSelect: () => undefined,
			});
		});
		expect(openParam()?.activeIndex).toBe(0);
		act(() => setTypeaheadActiveIndex(2));
		expect(openParam()?.activeIndex).toBe(2);
	});

	it("re-opening while open refreshes in place (update, not stack)", () => {
		act(() => {
			openTypeaheadMenu({
				items: ITEMS,
				anchor,
				activeIndex: 0,
				ariaLabel: "Slash commands",
				onSelect: () => undefined,
			});
			openTypeaheadMenu({
				items: ITEMS.slice(0, 1),
				anchor,
				activeIndex: 0,
				ariaLabel: "Slash commands",
				onSelect: () => undefined,
			});
		});
		const open =
			getActiveMenuStore()
				?.getAll()
				.filter((m) => m.id === TYPEAHEAD_MENU_ID) ?? [];
		expect(open).toHaveLength(1);
		expect(openParam()?.data?.items).toHaveLength(1);
	});

	it("closes", () => {
		act(() => {
			openTypeaheadMenu({
				items: ITEMS,
				anchor,
				activeIndex: 0,
				ariaLabel: "Slash commands",
				onSelect: () => undefined,
			});
		});
		expect(getActiveMenuStore()?.isOpen(TYPEAHEAD_MENU_ID)).toBe(true);
		act(() => closeTypeaheadMenu());
		expect(getActiveMenuStore()?.isOpen(TYPEAHEAD_MENU_ID)).toBe(false);
	});
});
