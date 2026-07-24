// @vitest-environment jsdom
/**
 * Apply-to-type wiring (8.10.5). The Builder's "Apply to type" action
 * promotes the form to the default `brainstorm/Layout/v1` for its target
 * type: it validates the layout through the frozen `validateAppLayouts`
 * contract (the SAME bar the installer enforces on app-shipped defaults)
 * and, on pass, persists a type-scoped Layout via the capability-gated
 * vault `entities` service. Guards (no name / no fields) block the apply.
 * The pure round-trips (projection, install-contract, resolver) are unit-
 * tested in `form-model.test`; this proves the app wires the action.
 */

import { LAYOUT_TYPE_URL, ValueType } from "@brainstorm-os/sdk-types";
import { type AnchoredMenuItem, openAnchoredMenu } from "@brainstorm-os/sdk/object-menu";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FormDesignerApp } from "./app";

vi.mock("@brainstorm-os/sdk/object-menu", () => ({ openAnchoredMenu: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class StubResizeObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

const createSpy = vi.fn(() => Promise.resolve({ id: "layout-new" }));
const updateSpy = vi.fn(() => Promise.resolve(null));

function installShell(): void {
	(window as { brainstorm?: unknown }).brainstorm = {
		on: (_event: string, handler: () => void) => {
			handler();
			return { unsubscribe: () => {} };
		},
		services: {
			vaultEntities: {
				list: () => Promise.resolve({ entities: [], links: [] }),
				onChange: () => ({ unsubscribe: () => {} }),
			},
			properties: {
				list: () =>
					Promise.resolve({
						properties: {
							name: { key: "name", name: "Name", icon: null, valueType: ValueType.Text },
						},
					}),
			},
			entities: {
				get: vi.fn(() => Promise.resolve(null)),
				create: createSpy,
				update: updateSpy,
				delete: vi.fn(() => Promise.resolve()),
				query: vi.fn(() => Promise.resolve([])),
			},
		},
	};
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function renderApp(): Promise<HTMLDivElement> {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	await act(async () => root?.render(<FormDesignerApp />));
	await act(async () => {
		await Promise.resolve();
	});
	return container;
}

function setInput(input: HTMLInputElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	setter?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

function clickByText(el: HTMLElement, selector: string, text: string): void {
	const btn = [...el.querySelectorAll<HTMLButtonElement>(selector)].find(
		(b) => b.textContent?.trim() === text,
	);
	if (!btn) throw new Error(`no ${selector} with text "${text}"`);
	btn.click();
}

/** Add the "Name" property field via the mocked add-field menu. */
async function addNameField(el: HTMLElement): Promise<void> {
	await act(async () => clickByText(el, ".bs-btn", "Add field"));
	const calls = vi.mocked(openAnchoredMenu).mock.calls;
	const items = calls[calls.length - 1]?.[1] as AnchoredMenuItem[];
	const nameItem = items.find((i) => i.label === "Name");
	if (!nameItem) throw new Error("no Name item in add-field menu");
	await act(async () => nameItem.onSelect?.());
}

function statusText(el: HTMLElement): string {
	return el.querySelector(".fd-status")?.textContent?.trim() ?? "";
}

beforeEach(() => {
	vi.stubGlobal("ResizeObserver", StubResizeObserver);
});

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	container = null;
	root = null;
	(window as { brainstorm?: unknown }).brainstorm = undefined;
	createSpy.mockClear();
	updateSpy.mockClear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("FormDesignerApp apply-to-type (8.10.5)", () => {
	it("validates + persists a type-scoped Layout carrying its scope", async () => {
		installShell();
		const el = await renderApp();

		const nameInput = el.querySelector<HTMLInputElement>(".fd-input.bs-input");
		await act(async () => setInput(nameInput as HTMLInputElement, "New task"));
		await addNameField(el);

		await act(async () => clickByText(el, ".bs-btn", "Apply to type"));
		await act(async () => {
			await Promise.resolve();
		});

		expect(createSpy).toHaveBeenCalledTimes(1);
		const [type, props] = createSpy.mock.calls[0] as unknown as [string, Record<string, unknown>];
		expect(type).toBe(LAYOUT_TYPE_URL);
		expect(props.targetType).toBe("brainstorm/Object/v1");
		// The persisted entity is a self-describing type-scoped Layout — the
		// resolver-consumable "default layout for this type".
		expect(props.scope).toEqual({ kind: "type", target: "brainstorm/Object/v1" });
		expect(statusText(el)).toContain("Object");
	});

	it("blocks the apply when the form has no name", async () => {
		installShell();
		const el = await renderApp();
		await addNameField(el);

		await act(async () => clickByText(el, ".bs-btn", "Apply to type"));
		expect(createSpy).not.toHaveBeenCalled();
		expect(statusText(el)).toBe("Name the form before saving.");
	});

	it("blocks the apply when the form has no fields", async () => {
		installShell();
		const el = await renderApp();
		const nameInput = el.querySelector<HTMLInputElement>(".fd-input.bs-input");
		await act(async () => setInput(nameInput as HTMLInputElement, "Empty"));

		await act(async () => clickByText(el, ".bs-btn", "Apply to type"));
		expect(createSpy).not.toHaveBeenCalled();
		expect(statusText(el)).toBe("Add at least one field before saving.");
	});
});
