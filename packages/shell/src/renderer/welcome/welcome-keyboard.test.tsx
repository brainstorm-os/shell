// @vitest-environment jsdom
/**
 * KBN-S-welcome (12.4) — focus moves on each step transition: into the
 * create form's name field when entering it, back to the "Create vault"
 * CTA when returning to the menu, and not on the initial mount.
 */

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../vault-context", () => ({
	useVault: () => ({
		current: null,
		allVaults: [],
		create: vi.fn().mockResolvedValue(undefined),
		openByPath: vi.fn(),
		pickFolder: vi.fn(),
		defaultPath: vi.fn().mockResolvedValue("/vaults/personal"),
		checkPath: vi.fn().mockResolvedValue(null),
		activate: vi.fn(),
	}),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { Welcome } = await import("./welcome");
const { t } = await import("../i18n/t");

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});
afterEach(() => {
	act(() => root.unmount());
	host.remove();
});

async function mount() {
	await act(async () => {
		root.render(<Welcome />);
	});
	await act(async () => {
		await Promise.resolve();
	});
}

function buttonByText(text: string): HTMLButtonElement {
	const btn = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
		(b) => b.textContent?.trim() === text,
	);
	if (!btn) throw new Error(`button "${text}" not found`);
	return btn;
}

function click(el: HTMLElement) {
	act(() => {
		el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
}

describe("Welcome — KBN-S-welcome focus management", () => {
	it("does not steal focus on the initial menu mount", async () => {
		await mount();
		expect(document.activeElement).toBe(document.body);
	});

	it("focuses the name field when entering the create step", async () => {
		await mount();
		click(buttonByText(t("shell.welcome.createCta")));
		const nameInput = host.querySelector<HTMLInputElement>(".text-field__input");
		expect(document.activeElement).toBe(nameInput);
	});

	it("restores focus to the Create CTA when returning to the menu", async () => {
		await mount();
		click(buttonByText(t("shell.welcome.createCta")));
		// Back to the menu (the menu remounts, so re-query the fresh CTA node).
		click(buttonByText(t("shell.welcome.back")));
		expect(document.activeElement).toBe(buttonByText(t("shell.welcome.createCta")));
	});
});
