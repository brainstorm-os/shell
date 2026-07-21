// @vitest-environment jsdom
/**
 * KBN-S-bin — the Bin overlay's virtualized composite-listbox keyboard contract.
 * Focus stays on the list and `aria-activedescendant` tracks the active row;
 * ↑/↓ move the cursor, Enter restores the active row, Delete/Backspace purges it,
 * and the per-row Restore/Purge buttons are behind the cursor (tabindex -1), not
 * separate Tab stops.
 *
 * Assertions read `aria-activedescendant` off the list container (robust to
 * jsdom's no-layout virtualization) and the DOM-independent Enter/Delete paths;
 * scroll-into-view itself is layout-dependent and verified on the perf CI.
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

describe("Bin — KBN-S-bin virtualized listbox keyboard", () => {
	let host: HTMLDivElement;
	let root: Root;
	let uninstallEscape: () => void;
	let onClose: Mock<() => void>;
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
		onClose = vi.fn<() => void>();
	});

	afterEach(() => {
		uninstallEscape();
		act(() => root.unmount());
		host.remove();
	});

	async function mount(): Promise<void> {
		await act(async () => {
			root.render(<Bin onClose={onClose} />);
		});
		// Flush the useBin list() microtask.
		await act(async () => undefined);
	}

	const list = () => host.querySelector<HTMLElement>(".bin__list");
	const activeDesc = () => list()?.getAttribute("aria-activedescendant") ?? "";
	const press = (target: EventTarget | null, key: string) => {
		const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
		act(() => {
			target?.dispatchEvent(ev);
		});
		return ev;
	};

	it("is a hook-stamped vertical listbox with a live aria-activedescendant", async () => {
		await mount();
		expect(list()?.getAttribute("role")).toBe("listbox");
		expect(list()?.getAttribute("aria-orientation")).toBe("vertical");
		// Focus is on the container; the active row is tracked via activedescendant.
		expect(list()?.tabIndex).toBe(0);
		expect(activeDesc()).not.toBe("");
		// NOTE: per-row rendering (role="option" + tabindex -1 rows, action buttons
		// at tabindex -1) is layout-dependent — the virtualizer renders zero rows
		// under jsdom (no layout/height). The `getItemProps` / `tabIndex={-1}` wiring
		// is verified by review + the perf-CI Playwright pass, not here.
	});

	it("ArrowDown / ArrowUp move the active row via aria-activedescendant", async () => {
		await mount();
		expect(activeDesc()).toMatch(/-0$/);
		press(list(), "ArrowDown");
		expect(activeDesc()).toMatch(/-1$/);
		press(list(), "ArrowUp");
		expect(activeDesc()).toMatch(/-0$/);
	});

	it("Enter restores the active row", async () => {
		await mount();
		await act(async () => {
			list()?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
			);
		});
		expect(restore).toHaveBeenCalledWith("i1");
	});

	it("Delete purges the active row", async () => {
		await mount();
		press(list(), "ArrowDown"); // cursor → i2
		await act(async () => {
			list()?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }),
			);
		});
		// onPurge awaits confirm() (mocked true) then calls purge.
		await act(async () => undefined);
		expect(purge).toHaveBeenCalledWith("i2");
	});

	it("focus-traps + focuses the list on open (after items load) and closes on Escape", async () => {
		await mount();
		const panel = host.querySelector(".bin__panel");
		expect(panel?.contains(document.activeElement)).toBe(true);
		// The list is focused once items have loaded, so ↑/↓ work immediately
		// (the focus-on-open effect waits for the async-loaded list to render).
		expect(document.activeElement).toBe(list());
		press(document, "Escape");
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
