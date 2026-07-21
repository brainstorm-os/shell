// @vitest-environment jsdom
/**
 * Tests for `@brainstorm-os/sdk/select-menu` — the native-`<select>`
 * replacement. Asserts the trigger face (label / placeholder / aria), the
 * option list it opens through the shared context-menu config (check on the
 * chosen option, blank icon column on the rest, `<optgroup>`-style section
 * rows), and the controlled `onChange` flow for both the React and pure-DOM
 * twins.
 */

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BrainstormMenuProvider,
	CONTEXT_MENU_ID,
	type ContextMenuItem,
	closeContextMenu,
	getActiveMenuStore,
} from "../menus";
import { createSelectMenu } from "./create-select-menu";
import { openSelectMenu } from "./open-select-menu";
import { SelectMenu } from "./select-menu";

const OPTIONS = [
	{ value: "a", label: "Alpha" },
	{ value: "b", label: "Beta" },
	{ value: "c", label: "Gamma", disabled: true },
] as const;

function openItems(menuLabel: string): ContextMenuItem[] {
	const store = getActiveMenuStore();
	const id = `${CONTEXT_MENU_ID}:${menuLabel}`;
	const open = store?.getAll().find((m) => m.id === id);
	expect(open, `menu ${id} should be open`).toBeDefined();
	return (open?.param.data as { items: ContextMenuItem[] }).items;
}

describe("select-menu", () => {
	let host: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		act(() => {
			root.render(
				<BrainstormMenuProvider>
					<div />
				</BrainstormMenuProvider>,
			);
		});
	});
	afterEach(() => {
		act(() => closeContextMenu());
		act(() => root.unmount());
		host.remove();
	});

	describe("openSelectMenu", () => {
		it("maps options onto checked / blank-icon rows and fires onSelect", () => {
			const anchor = document.createElement("button");
			document.body.appendChild(anchor);
			const picked: string[] = [];

			act(() => {
				expect(
					openSelectMenu({
						anchor,
						menuLabel: "Fruit",
						options: OPTIONS,
						value: "b",
						onSelect: (v) => picked.push(v),
					}),
				).toBe(true);
			});

			const items = openItems("Fruit");
			expect(items.map((it) => it.label)).toEqual(["Alpha", "Beta", "Gamma"]);
			// The chosen option carries the selected state + check; the others a
			// blank icon param so the fixed icon column keeps labels aligned.
			expect(items[1]?.selected).toBe(true);
			expect(items[0]?.selected).toBeUndefined();
			expect(items[0]?.icon).toBeDefined();
			expect(items[2]?.disabled).toBe(true);

			items[0]?.onSelect?.();
			expect(picked).toEqual(["a"]);
			anchor.remove();
		});

		it("renders group headings as section rows (the optgroup analogue)", () => {
			const anchor = document.createElement("button");
			document.body.appendChild(anchor);
			act(() => {
				openSelectMenu({
					anchor,
					menuLabel: "Zone",
					options: [
						{ value: "x", label: "X", group: "Common" },
						{ value: "y", label: "Y", group: "Common" },
						{ value: "z", label: "Z", group: "Other" },
					],
					value: null,
					onSelect: () => undefined,
				});
			});
			const rows = openItems("Zone").map((it) => (it.section ? `#${it.label}` : it.label));
			expect(rows).toEqual(["#Common", "X", "Y", "#Other", "Z"]);
			anchor.remove();
		});
	});

	describe("<SelectMenu>", () => {
		it("shows the chosen label, opens on click, and commits a pick", () => {
			const changes: string[] = [];
			act(() => {
				root.render(
					<BrainstormMenuProvider>
						<SelectMenu
							value="a"
							options={OPTIONS}
							onChange={(next) => changes.push(next)}
							ariaLabel="Fruit"
						/>
					</BrainstormMenuProvider>,
				);
			});

			const trigger = host.querySelector<HTMLButtonElement>(".bs-select");
			expect(trigger).not.toBeNull();
			expect(trigger?.getAttribute("aria-haspopup")).toBe("menu");
			expect(trigger?.getAttribute("aria-label")).toBe("Fruit");
			expect(trigger?.querySelector(".bs-select__value")?.textContent).toBe("Alpha");
			expect(trigger?.querySelector(".bs-select__caret")).not.toBeNull();

			act(() => trigger?.click());
			const items = openItems("Fruit");
			expect(items[0]?.selected).toBe(true);

			act(() => items[1]?.onSelect?.());
			expect(changes).toEqual(["b"]);
		});

		it("falls back to the placeholder when the value matches no option", () => {
			act(() => {
				root.render(
					<BrainstormMenuProvider>
						<SelectMenu
							value={null}
							options={OPTIONS}
							onChange={() => undefined}
							ariaLabel="Fruit"
							placeholder="Pick one"
						/>
					</BrainstormMenuProvider>,
				);
			});
			const value = host.querySelector(".bs-select__value");
			expect(value?.textContent).toBe("Pick one");
			expect(value?.classList.contains("bs-select__value--empty")).toBe(true);
		});
	});

	describe("createSelectMenu", () => {
		it("renders the same trigger DOM and reflects picks + external set", () => {
			const changes: string[] = [];
			const handle = createSelectMenu({
				options: OPTIONS,
				value: "a",
				ariaLabel: "Fruit",
				onChange: (next) => changes.push(next),
			});
			document.body.appendChild(handle.element);
			expect(handle.element.classList.contains("bs-select")).toBe(true);
			expect(handle.element.querySelector(".bs-select__value")?.textContent).toBe("Alpha");

			act(() => handle.element.click());
			const items = openItems("Fruit");
			act(() => items[1]?.onSelect?.());
			expect(changes).toEqual(["b"]);
			// The pick reflects on the trigger before/independently of the host.
			expect(handle.element.querySelector(".bs-select__value")?.textContent).toBe("Beta");
			expect(handle.getValue()).toBe("b");

			// External value change (a host re-render) repaints without firing.
			handle.setValue("c");
			expect(handle.element.querySelector(".bs-select__value")?.textContent).toBe("Gamma");
			expect(changes).toEqual(["b"]);
			handle.element.remove();
		});
	});
});
