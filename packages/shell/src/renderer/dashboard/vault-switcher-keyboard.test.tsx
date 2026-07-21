// @vitest-environment jsdom
/**
 * KBN-S-vault-switcher — the vault-switcher popover's composite-listbox keyboard
 * contract. ↑/↓ move the cursor (selection follows focus), Enter activates, and
 * the `listbox`/`option` roles flow through `useCompositeKeyboard` (no
 * hand-written literal). The `<Popover>` focus trap itself is covered by
 * `popover.test.tsx`; pure sort/selection helpers by `vault-switcher-popover.test.tsx`.
 */

import { getEscapeStack, installEscapeHandler } from "@brainstorm-os/sdk/a11y";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VaultEntry } from "../../preload";
import { VaultSwitcherPopover } from "./vault-switcher-popover";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function vault(id: string, lastOpenedAt: number): VaultEntry {
	return {
		id,
		name: `Vault ${id}`,
		color: "#abcdef",
		path: `/vaults/${id}`,
		lastOpenedAt,
		format: "brainstorm/1",
	} as unknown as VaultEntry;
}

// Sorted by lastOpenedAt desc → [b, c, a]. current = "b" → initial cursor skips
// it to index 1 ("c").
const VAULTS = [vault("a", 100), vault("b", 300), vault("c", 200)];

describe("VaultSwitcherPopover — KBN-S-vault-switcher keyboard", () => {
	let host: HTMLDivElement;
	let root: Root;
	let uninstallEscape: () => void;
	let onActivate: Mock<(id: string) => void>;
	let onClose: Mock<() => void>;

	beforeEach(() => {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		uninstallEscape = installEscapeHandler(getEscapeStack());
		onActivate = vi.fn<(id: string) => void>();
		onClose = vi.fn<() => void>();
	});

	afterEach(() => {
		uninstallEscape();
		act(() => root.unmount());
		host.remove();
	});

	function mount(): void {
		act(() => {
			root.render(
				<VaultSwitcherPopover
					current={VAULTS[1] ?? null}
					vaults={VAULTS}
					onActivate={onActivate}
					onOpenAnother={() => undefined}
					onClose={onClose}
				/>,
			);
		});
	}

	const listbox = () => document.querySelector<HTMLElement>(".vault-switcher__list");
	const options = () => document.querySelectorAll<HTMLElement>('[role="option"]');
	const pressOnList = (key: string) => {
		const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
		act(() => {
			listbox()?.dispatchEvent(ev);
		});
		return ev;
	};

	it("stamps the listbox role + vertical orientation through the hook", () => {
		mount();
		expect(listbox()?.getAttribute("role")).toBe("listbox");
		expect(listbox()?.getAttribute("aria-orientation")).toBe("vertical");
		expect(options()).toHaveLength(3);
	});

	it("opens with the cursor on the first non-current vault and focuses the list", () => {
		mount();
		// Sorted [b, c, a]; current = b → cursor on index 1 (c).
		expect(options()[1]?.getAttribute("aria-selected")).toBe("true");
		expect(listbox()?.contains(document.activeElement)).toBe(true);
	});

	it("ArrowDown / ArrowUp move the active option", () => {
		mount();
		pressOnList("ArrowDown");
		expect(options()[2]?.getAttribute("aria-selected")).toBe("true");
		pressOnList("ArrowUp");
		expect(options()[1]?.getAttribute("aria-selected")).toBe("true");
	});

	it("Enter activates the cursor vault and closes", () => {
		mount();
		pressOnList("Enter");
		// Cursor starts on index 1 of sorted [b, c, a] → vault "c".
		expect(onActivate).toHaveBeenCalledWith("c");
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
