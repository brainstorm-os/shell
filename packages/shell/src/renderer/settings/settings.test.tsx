// @vitest-environment jsdom
/**
 * KBN-S-settings — the Settings overlay's keyboard contract. The sidebar
 * composite (arrows / type-ahead / roving tabindex / roles) is covered by the
 * SDK `useCompositeKeyboard` tests; this file covers the two pieces wired into
 * `settings.tsx` itself: the dialog focus-trap (Tab can't leak to the
 * dashboard behind it, focus restores to the opener, Escape closes via the
 * shared stack) and F6 region navigation between the sidebar and main panel.
 *
 * Rendered against the trivial `General` section so the trap/region behaviour
 * is exercised without mounting the heavier section bodies.
 */

import { getEscapeStack, installEscapeHandler } from "@brainstorm-os/sdk/a11y";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsSection } from "./sections";
import { Settings } from "./settings";

vi.mock("../vault-context", () => ({
	useVault: () => ({ current: { name: "Test Vault" }, close: vi.fn() }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function dispatchKey(target: EventTarget, key: string, init: KeyboardEventInit = {}): void {
	act(() => {
		target.dispatchEvent(
			new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
		);
	});
}

describe("Settings — KBN-S-settings focus trap + F6 region nav", () => {
	let host: HTMLDivElement;
	let root: Root;
	let uninstallEscape: () => void;
	let onClose: Mock<() => void>;

	beforeEach(() => {
		(window as unknown as { brainstorm: unknown }).brainstorm = {
			version: "0.0.1",
			vaults: { session: () => Promise.resolve(null) },
			// General section now renders the Updates panel (13.6 + 13.12).
			update: {
				getPrefs: () => Promise.resolve({ channel: "stable", lastCheckedAt: null }),
				check: () => Promise.resolve({}),
				setChannel: () => Promise.resolve({ channel: "stable", lastCheckedAt: null }),
				getState: () => Promise.resolve({ lifecycle: "unsupported" }),
				checkAuto: () => Promise.resolve({ lifecycle: "unsupported" }),
				download: () => Promise.resolve({ lifecycle: "unsupported" }),
				installNow: () => Promise.resolve(),
				onStateChange: () => () => {},
			},
			intents: { dispatch: () => Promise.resolve({ handled: true }) },
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

	function mount(): void {
		act(() => {
			root.render(<Settings onClose={onClose} initialSection={SettingsSection.General} />);
		});
	}

	function panel(): HTMLElement {
		const el = host.querySelector<HTMLElement>(".settings__panel");
		if (!el) throw new Error("settings panel not mounted");
		return el;
	}

	it("moves focus into the panel on open (not the opener, not <body>)", () => {
		const opener = document.createElement("button");
		document.body.appendChild(opener);
		opener.focus();
		expect(document.activeElement).toBe(opener);

		mount();

		expect(document.activeElement).not.toBe(opener);
		expect(document.activeElement).not.toBe(document.body);
		expect(panel().contains(document.activeElement)).toBe(true);

		opener.remove();
	});

	it("restores focus to the opener when the overlay unmounts", () => {
		const opener = document.createElement("button");
		document.body.appendChild(opener);
		opener.focus();

		mount();
		expect(panel().contains(document.activeElement)).toBe(true);

		act(() => root.render(null));
		expect(document.activeElement).toBe(opener);

		opener.remove();
	});

	it("closes via Escape through the shared escape stack", () => {
		mount();
		dispatchKey(document, "Escape");
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("wraps Tab at the trap boundary (last focusable → first)", () => {
		mount();
		const focusables = panel().querySelectorAll<HTMLElement>(
			"button:not([disabled]),[tabindex]:not([tabindex='-1'])",
		);
		const first = focusables[0];
		const last = focusables[focusables.length - 1];
		expect(first).toBeDefined();
		expect(last).toBeDefined();
		(last as HTMLElement).focus();
		dispatchKey(last as HTMLElement, "Tab");
		expect(document.activeElement).toBe(first);
	});

	it("F6 jumps to the main region, then back to the active sidebar option", () => {
		mount();
		const main = panel().querySelector<HTMLElement>(".settings__main");
		const activeNavItem = panel().querySelector<HTMLElement>(".settings__nav-item--active");
		expect(main).toBeDefined();
		expect(activeNavItem).toBeDefined();

		dispatchKey(document, "F6");
		expect(document.activeElement).toBe(main);

		dispatchKey(document, "F6");
		expect(document.activeElement).toBe(activeNavItem);
	});
});
