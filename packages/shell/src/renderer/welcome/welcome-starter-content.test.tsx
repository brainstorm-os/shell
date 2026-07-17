// @vitest-environment jsdom
/**
 * Welcome-1b opt-out — the create-vault form's "Add starter content" checkbox.
 * It is on (seed) by default; toggling it off threads `seedStarterContent:
 * false` into `vaults.create`, which pre-stamps the seed so the vault-init
 * seeder no-ops (proven main-side in `vault-welcome-optout.test.ts`).
 */

import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const create: Mock = vi.fn().mockResolvedValue({
	id: "vlt_x",
	name: "Personal",
	color: "#14b8a6",
	path: "/vaults/personal",
	lastOpenedAt: 0,
	format: "1.0",
});

vi.mock("../vault-context", () => ({
	useVault: () => ({
		current: null,
		allVaults: [],
		create,
		openByPath: vi.fn(),
		pickFolder: vi.fn(),
		defaultPath: vi.fn().mockResolvedValue("/vaults/personal"),
		checkPath: vi.fn().mockResolvedValue(null),
		activate: vi.fn(),
	}),
}));

const { Welcome } = await import("./welcome");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
	create.mockClear();
});

async function flush(): Promise<void> {
	// Let the `defaultPath` effect resolve and repaint so the submit enables.
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

async function enterCreateMode(): Promise<void> {
	await act(async () => {
		root.render(<Welcome />);
	});
	await flush();
	const cta = host.querySelector<HTMLButtonElement>('[data-testid="welcome-create-cta"]');
	if (!cta) throw new Error("create CTA not found");
	await act(async () => {
		cta.click();
	});
	await flush();
	// The name field starts empty (no pre-fill) — type one so step 1 validates.
	await typeName("Personal");
	await flush();
	// Step 1 → step 2 (the starter-content checkbox now lives on step 2).
	await act(async () => submit());
	await flush();
}

async function typeName(value: string): Promise<void> {
	const input = host.querySelector<HTMLInputElement>("input.text-field__input");
	if (!input) throw new Error("name input not found");
	const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	await act(async () => {
		setValue?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

function checkbox(): HTMLInputElement {
	const el = host.querySelector<HTMLInputElement>('[data-testid="welcome-starter-content"]');
	if (!el) throw new Error("starter-content checkbox not found");
	return el;
}

function submit(): void {
	const form = host.querySelector("form");
	if (!form) throw new Error("create form not found");
	form.requestSubmit();
}

describe("Welcome — starter-content opt-out", () => {
	it("defaults the starter-content checkbox to checked", async () => {
		await enterCreateMode();
		expect(checkbox().checked).toBe(true);
	});

	it("associates the hint with the checkbox for screen readers", async () => {
		await enterCreateMode();
		const describedBy = checkbox().getAttribute("aria-describedby");
		expect(describedBy).toBeTruthy();
		const hint = host.querySelector(`#${describedBy}`);
		expect(hint?.textContent?.trim()).not.toBe("");
	});

	it("seeds by default (seedStarterContent: true)", async () => {
		await enterCreateMode();
		await act(async () => submit());
		expect(create).toHaveBeenCalledWith(expect.objectContaining({ seedStarterContent: true }));
	});

	it("opts out when the checkbox is unchecked (seedStarterContent: false)", async () => {
		await enterCreateMode();
		await act(async () => {
			checkbox().click();
		});
		await act(async () => submit());
		expect(create).toHaveBeenCalledWith(expect.objectContaining({ seedStarterContent: false }));
	});
});
