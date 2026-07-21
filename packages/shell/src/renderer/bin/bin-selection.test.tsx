// @vitest-environment jsdom
/**
 * Bin multi-select — the checkbox / select-all / batch-action contract layered
 * over the KBN-S-bin listbox. The deleted-objects listbox is now
 * `aria-multiselectable`; Space toggles the active row's membership, the
 * select-all button drives a tri-state `aria-checked`, and the footer swaps to
 * a bulk Restore / Delete-forever bar while ≥1 row is checked.
 *
 * Like `bin-keyboard.test.tsx`, per-row DOM is layout-dependent (the virtualizer
 * renders zero rows under jsdom), so the assertions read the DOM-stable signals:
 * the container's `aria-multiselectable`, the select-all `aria-checked`, and the
 * footer that reacts to the (id-keyed) selection count.
 */

import { getEscapeStack, installEscapeHandler } from "@brainstorm-os/sdk/a11y";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Bin } from "./bin";

vi.mock("../ui/confirm", () => ({
	confirm: () => Promise.resolve(true),
	ConfirmVariant: { Destructive: "destructive" },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ITEMS = [
	{ id: "i1", title: "Alpha", icon: null, deletedAt: 1_700_000_000_000 },
	{ id: "i2", title: "Bravo", icon: null, deletedAt: 1_700_000_000_000 },
	{ id: "i3", title: "Charlie", icon: null, deletedAt: 1_700_000_000_000 },
];

describe("Bin — multi-select + batch actions", () => {
	let host: HTMLDivElement;
	let root: Root;
	let uninstallEscape: () => void;
	let restore: Mock<(id: string) => Promise<boolean>>;
	let purge: Mock<(id: string) => Promise<boolean>>;

	beforeEach(() => {
		restore = vi.fn<(id: string) => Promise<boolean>>(() => Promise.resolve(true));
		purge = vi.fn<(id: string) => Promise<boolean>>(() => Promise.resolve(true));
		(window as unknown as { brainstorm: unknown }).brainstorm = {
			bin: {
				list: () => Promise.resolve(ITEMS),
				restore,
				purge,
				empty: () => Promise.resolve(0),
			},
			dashboard: {
				snapshot: () => Promise.resolve({ icons: {} }),
				on: () => () => undefined,
				upsertIcon: () => Promise.resolve(),
				removeIcon: () => Promise.resolve(),
			},
		};
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		uninstallEscape = installEscapeHandler(getEscapeStack());
	});

	afterEach(() => {
		uninstallEscape();
		act(() => root.unmount());
		host.remove();
	});

	async function mount(): Promise<void> {
		await act(async () => {
			root.render(<Bin onClose={vi.fn()} />);
		});
		await act(async () => undefined);
	}

	const list = () => host.querySelector<HTMLElement>(".bin__list");
	const selectAll = () => host.querySelector<HTMLInputElement>(".bin__header .checkbox__input");
	const footer = () => host.querySelector<HTMLElement>(".bin__footer");
	const footerButton = (label: string) =>
		Array.from(host.querySelectorAll<HTMLButtonElement>(".bin__footer button")).find((b) =>
			(b.textContent ?? "").includes(label),
		) ?? null;
	const press = (target: EventTarget | null, key: string) => {
		act(() => {
			target?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
		});
	};

	it("is an aria-multiselectable listbox with a tri-state select-all", async () => {
		await mount();
		expect(list()?.getAttribute("aria-multiselectable")).toBe("true");
		// Nothing selected → select-all unchecked, footer shows the lone Empty Bin.
		expect(selectAll()?.checked).toBe(false);
		expect(selectAll()?.indeterminate).toBe(false);
		expect(host.querySelector(".bin__selection")).toBeNull();
		expect(footer()?.textContent).toContain("Empty Bin");
	});

	it("Space toggles the active row into / out of the selection", async () => {
		await mount();
		// Cursor starts at row 0; Space checks it → partial selection (1 of 3).
		press(list(), " ");
		expect(selectAll()?.indeterminate).toBe(true);
		expect(selectAll()?.checked).toBe(false);
		expect(host.querySelector(".bin__selection")?.textContent).toContain("1 selected");
		// Space again clears it → back to the Empty Bin footer.
		press(list(), " ");
		expect(selectAll()?.indeterminate).toBe(false);
		expect(host.querySelector(".bin__selection")).toBeNull();
	});

	it("select-all checks every row; clearing resets it", async () => {
		await mount();
		act(() => selectAll()?.click());
		expect(selectAll()?.checked).toBe(true);
		expect(selectAll()?.indeterminate).toBe(false);
		expect(host.querySelector(".bin__selection")?.textContent).toContain("3 selected");
		act(() => footerButton("Clear")?.click());
		expect(selectAll()?.checked).toBe(false);
	});

	it("batch Restore restores every checked row, then clears the selection", async () => {
		await mount();
		act(() => selectAll()?.click());
		await act(async () => {
			footerButton("Restore")?.click();
		});
		await act(async () => undefined);
		expect(restore).toHaveBeenCalledTimes(3);
		expect(restore.mock.calls.map((c) => c[0])).toEqual(["i1", "i2", "i3"]);
	});

	it("batch Delete purges every checked row through the confirm dialog", async () => {
		await mount();
		act(() => selectAll()?.click());
		await act(async () => {
			footerButton("Delete forever")?.click();
		});
		await act(async () => undefined);
		expect(purge).toHaveBeenCalledTimes(3);
		expect(purge.mock.calls.map((c) => c[0])).toEqual(["i1", "i2", "i3"]);
	});
});
