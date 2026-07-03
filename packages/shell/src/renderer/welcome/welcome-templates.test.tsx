// @vitest-environment jsdom
/**
 * Welcome-2 (9.3.5.V 7d) — first-launch template gallery wiring. Selecting a
 * template supersedes the generic example seed (`seedStarterContent: false`)
 * and imports the chosen template after the vault is created; selecting none
 * leaves the default seed behaviour untouched.
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

const listTemplates: Mock = vi.fn().mockResolvedValue([
	{
		id: "project-management",
		name: "Project management",
		description: "A project with tasks, a kickoff note, and a kickoff meeting.",
	},
	{ id: "research", name: "Research", description: "A thesis note and captured sources." },
]);
const importTemplate: Mock = vi.fn().mockResolvedValue({ ok: true, result: { templateId: "x" } });

const { Welcome } = await import("./welcome");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	(window as unknown as { brainstorm: unknown }).brainstorm = {
		welcome: { listTemplates, importTemplate },
	};
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	create.mockClear();
	importTemplate.mockClear();
	listTemplates.mockClear();
});

async function flush(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	});
}

/** Render → create menu → step 1 (name/location) → step 2 (starting point,
 *  where the starter checkbox + template gallery live). A typed name + the
 *  mocked path make step 1 valid, so the Continue submit advances. */
async function enterCreateMode(): Promise<void> {
	await act(async () => {
		root.render(<Welcome />);
	});
	await flush();
	const cta = host.querySelector<HTMLButtonElement>('[data-testid="welcome-create-cta"]');
	if (!cta) throw new Error("create CTA not found");
	await act(async () => cta.click());
	await flush();
	// The name field starts empty (no pre-fill) — type one so step 1 validates.
	await typeName("Personal");
	await flush();
	// Advance step 1 → step 2 (Continue submits the name/location form).
	await act(async () => submit());
	await flush();
}

async function typeName(value: string): Promise<void> {
	const input = host.querySelector<HTMLInputElement>("input.welcome__input");
	if (!input) throw new Error("name input not found");
	const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	await act(async () => {
		setValue?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

function card(id: string): HTMLButtonElement {
	const el = host.querySelector<HTMLButtonElement>(`[data-testid="welcome-template-${id}"]`);
	if (!el) throw new Error(`template card ${id} not found`);
	return el;
}

function submit(): void {
	const form = host.querySelector("form");
	if (!form) throw new Error("create form not found");
	form.requestSubmit();
}

describe("Welcome — template gallery", () => {
	it("renders a card per template once the list loads", async () => {
		await enterCreateMode();
		expect(host.querySelector('[data-testid="welcome-templates"]')).not.toBeNull();
		expect(card("project-management")).not.toBeNull();
		expect(card("research")).not.toBeNull();
	});

	it("imports the chosen template and skips the generic seed", async () => {
		await enterCreateMode();
		await act(async () => card("project-management").click());
		await flush();
		await act(async () => submit());
		await flush();
		expect(create).toHaveBeenCalledWith(expect.objectContaining({ seedStarterContent: false }));
		expect(importTemplate).toHaveBeenCalledWith("project-management");
	});

	it("marks the chosen card pressed and disables the starter checkbox", async () => {
		await enterCreateMode();
		await act(async () => card("project-management").click());
		await flush();
		expect(card("project-management").getAttribute("aria-pressed")).toBe("true");
		const checkbox = host.querySelector<HTMLInputElement>('[data-testid="welcome-starter-content"]');
		expect(checkbox?.disabled).toBe(true);
	});

	it("toggles a selected template back off, restoring the default seed", async () => {
		await enterCreateMode();
		await act(async () => card("project-management").click());
		await flush();
		await act(async () => card("project-management").click());
		await flush();
		await act(async () => submit());
		await flush();
		expect(create).toHaveBeenCalledWith(expect.objectContaining({ seedStarterContent: true }));
		expect(importTemplate).not.toHaveBeenCalled();
	});

	it("leaves the default seed path untouched when no template is chosen", async () => {
		await enterCreateMode();
		await act(async () => submit());
		await flush();
		expect(create).toHaveBeenCalledWith(expect.objectContaining({ seedStarterContent: true }));
		expect(importTemplate).not.toHaveBeenCalled();
	});
});

describe("Welcome — two-step create flow", () => {
	it("keeps the template gallery off step 1 until Continue advances to step 2", async () => {
		// Render → create menu → step 1 (no templates yet).
		await act(async () => {
			root.render(<Welcome />);
		});
		await flush();
		host.querySelector<HTMLButtonElement>('[data-testid="welcome-create-cta"]')?.click();
		await flush();
		expect(host.querySelector('[data-testid="welcome-templates"]')).toBeNull();
		// Continue (with a typed name — the field starts empty) → step 2.
		await typeName("Personal");
		await flush();
		await act(async () => submit());
		await flush();
		expect(host.querySelector('[data-testid="welcome-templates"]')).not.toBeNull();
	});

	it("Skip creates an empty vault — no template, no starter content", async () => {
		await enterCreateMode();
		const skip = Array.from(host.querySelectorAll("button")).find(
			(b) => b.textContent?.trim() === "Skip",
		);
		expect(skip).toBeTruthy();
		await act(async () => skip?.click());
		await flush();
		expect(create).toHaveBeenCalledWith(expect.objectContaining({ seedStarterContent: false }));
		expect(importTemplate).not.toHaveBeenCalled();
	});
});
