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
import { t } from "../i18n/t";
import { SETTINGS_GROUP_LABEL_KEYS, SettingsSection } from "./sections";
import { NAV_GROUPS, NAV_ITEMS, Settings } from "./settings";

/** Narrow an indexed lookup without a non-null assertion (biome forbids `!`).
 *  A miss is a broken fixture, so throwing here reads as the test's own
 *  precondition failing rather than an obscure `undefined` deref downstream. */
function required<T>(value: T | null | undefined, what: string): T {
	if (value === null || value === undefined) throw new Error(`missing ${what}`);
	return value;
}

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

function installBrainstormBridge(): void {
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
}

describe("Settings — KBN-S-settings focus trap + F6 region nav", () => {
	let host: HTMLDivElement;
	let root: Root;
	let uninstallEscape: () => void;
	let onClose: Mock<() => void>;

	beforeEach(() => {
		installBrainstormBridge();
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

/**
 * The sidebar nav is grouped (owner report 2026-08-10 — 22 flat entries, four
 * of them below the fold). Grouping a composite listbox is exactly where the
 * roving-tabindex contract breaks: a heading that lands in the item index
 * space shifts every index after it, and a heading that is focusable stops
 * ArrowDown at the group seam. These tests pin both.
 */
describe("Settings — grouped sidebar nav", () => {
	let host: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		installBrainstormBridge();
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
	});

	afterEach(() => {
		act(() => root.unmount());
		host.remove();
	});

	function mountAt(section: SettingsSection): void {
		act(() => {
			root.render(<Settings onClose={() => {}} initialSection={section} />);
		});
	}

	function nav(): HTMLElement {
		const el = host.querySelector<HTMLElement>(".settings__nav");
		if (!el) throw new Error("settings nav not mounted");
		return el;
	}

	function options(): HTMLElement[] {
		return [...nav().querySelectorAll<HTMLElement>('[role="option"]')];
	}

	it("renders one labelled group per NAV_GROUPS, in declared order", () => {
		mountAt(SettingsSection.General);
		const groups = [...nav().querySelectorAll<HTMLElement>('[role="group"]')];
		expect(groups.length).toBe(NAV_GROUPS.length);
		for (const [i, group] of groups.entries()) {
			const declared = required(NAV_GROUPS[i], `NAV_GROUPS[${i}]`);
			const labelledBy = group.getAttribute("aria-labelledby");
			expect(labelledBy, `group ${i} has no aria-labelledby`).toBeTruthy();
			const heading = document.getElementById(required(labelledBy, "aria-labelledby"));
			expect(heading, `aria-labelledby=${labelledBy} resolves to nothing`).not.toBeNull();
			expect(heading?.textContent).toBe(t(SETTINGS_GROUP_LABEL_KEYS[declared.id]));
			// The group owns exactly its own options — no leakage across seams.
			expect(group.querySelectorAll('[role="option"]').length).toBe(declared.items.length);
		}
	});

	it("group headings are not focusable and are not options", () => {
		mountAt(SettingsSection.General);
		const headings = [...nav().querySelectorAll<HTMLElement>(".settings__nav-group-label")];
		expect(headings.length).toBe(NAV_GROUPS.length);
		for (const heading of headings) {
			expect(heading.tagName).not.toBe("BUTTON");
			expect(heading.hasAttribute("tabindex")).toBe(false);
			expect(heading.getAttribute("role")).not.toBe("option");
			// Not in the roving / type-ahead index space.
			expect(heading.hasAttribute("data-composite-index")).toBe(false);
		}
	});

	it("options hold a contiguous composite index space matching NAV_ITEMS order", () => {
		mountAt(SettingsSection.General);
		const indices = options().map((el) => Number(el.getAttribute("data-composite-index")));
		expect(indices).toEqual(NAV_ITEMS.map((_, i) => i));
		expect(options().map((el) => el.textContent?.trim())).toEqual(
			NAV_ITEMS.map((entry) => t(entry.labelKey)),
		);
	});

	it("exactly one option is tabbable (roving tabindex), and it is the active section", () => {
		mountAt(SettingsSection.General);
		const tabbable = options().filter((el) => el.getAttribute("tabindex") === "0");
		expect(tabbable.length).toBe(1);
		expect(tabbable[0]?.className).toContain("settings__nav-item--active");
	});

	it("ArrowDown crosses a group seam — the last item of a group reaches the first of the next", () => {
		const firstGroup = required(NAV_GROUPS[0], "NAV_GROUPS[0]");
		const secondGroup = required(NAV_GROUPS[1], "NAV_GROUPS[1]");
		const seamIndex = firstGroup.items.length - 1;
		const lastOfFirst = required(firstGroup.items[seamIndex], "last item of the first group");
		const firstOfSecond = required(secondGroup.items[0], "first item of the second group");

		mountAt(lastOfFirst.id);
		const from = required(options()[seamIndex], `option at the group seam (${seamIndex})`);
		act(() => from.focus());

		dispatchKey(from, "ArrowDown");

		const landed = document.activeElement as HTMLElement | null;
		expect(landed?.getAttribute("data-composite-index")).toBe(String(seamIndex + 1));
		expect(landed?.textContent?.trim()).toBe(t(firstOfSecond.labelKey));
		expect(landed?.className).toContain("settings__nav-item--active");
	});
});
