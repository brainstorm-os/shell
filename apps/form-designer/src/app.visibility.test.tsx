// @vitest-environment jsdom
/**
 * Fill-mode conditional-visibility wiring (8.10.4). A saved form whose
 * `giftNote` field carries a `condition` must, in Fill mode, hide that
 * field until the rule holds against the in-progress values — and a
 * hidden field must neither block Create nor land in the created entity's
 * properties. The predicate evaluation + property projection are unit-
 * tested in `visibility-rules.test`; this proves the app renders and
 * submits off the *visible* set.
 */

import { LAYOUT_TYPE_URL, LayoutCellKind } from "@brainstorm-os/sdk-types";
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

const createSpy = vi.fn(() => Promise.resolve({ id: "new" }));

/** A form with an unconditional `wantsGift` field and a `giftNote` field
 *  shown only when `wantsGift` equals "yes". */
function giftFormRow(): { id: string; type: string; properties: Record<string, unknown> } {
	return {
		id: "gift",
		type: LAYOUT_TYPE_URL,
		properties: {
			name: "Gift form",
			targetType: "brainstorm/Object/v1",
			cells: [
				{ kind: LayoutCellKind.Property, id: "field-0", property: "wantsGift" },
				{
					kind: LayoutCellKind.Property,
					id: "field-1",
					property: "giftNote",
					condition: { $eq: { wantsGift: "yes" } },
				},
			],
		},
	};
}

function installShell(): void {
	(window as { brainstorm?: unknown }).brainstorm = {
		on: (_event: string, handler: () => void) => {
			handler();
			return { unsubscribe: () => {} };
		},
		services: {
			vaultEntities: {
				list: () => Promise.resolve({ entities: [giftFormRow()], links: [] }),
				onChange: () => ({ unsubscribe: () => {} }),
			},
			entities: {
				get: vi.fn(() => Promise.resolve(null)),
				create: createSpy,
				update: vi.fn(() => Promise.resolve(null)),
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

function clickByText(el: HTMLElement, selector: string, text: string): void {
	const btn = [...el.querySelectorAll<HTMLButtonElement>(selector)].find(
		(b) => b.textContent?.trim() === text,
	);
	if (!btn) throw new Error(`no ${selector} with text "${text}"`);
	btn.click();
}

/** Set a controlled input's value the way React observes it. */
function setInput(input: HTMLInputElement, value: string): void {
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	setter?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

function fillRowInputs(el: HTMLElement): HTMLInputElement[] {
	return [...el.querySelectorAll<HTMLInputElement>(".fd-fill__row .fd-input")];
}

async function loadFormIntoFill(el: HTMLElement): Promise<void> {
	await act(async () => el.querySelector<HTMLButtonElement>(".fd-sidebar__item")?.click());
	await act(async () => clickByText(el, ".bs-segmented__tab", "Fill"));
	await act(async () => {
		await Promise.resolve();
	});
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
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("FormDesignerApp Fill-mode visibility (8.10.4)", () => {
	it("hides a conditional field until its rule is met", async () => {
		installShell();
		const el = await renderApp();
		await loadFormIntoFill(el);

		// Only `wantsGift` shows while its value is empty.
		expect(fillRowInputs(el)).toHaveLength(1);

		await act(async () => setInput(fillRowInputs(el)[0] as HTMLInputElement, "yes"));
		// The rule now holds → `giftNote` appears.
		expect(fillRowInputs(el)).toHaveLength(2);

		await act(async () => setInput(fillRowInputs(el)[0] as HTMLInputElement, "no"));
		expect(fillRowInputs(el)).toHaveLength(1);
	});

	it("creates off the visible set — a hidden field never blocks or persists", async () => {
		installShell();
		const el = await renderApp();
		await loadFormIntoFill(el);

		// `wantsGift` = "no" keeps `giftNote` hidden. Create must succeed
		// (not blocked by the hidden required field) and omit `giftNote`.
		await act(async () => setInput(fillRowInputs(el)[0] as HTMLInputElement, "no"));
		await act(async () => clickByText(el, ".bs-btn", "Create"));
		await act(async () => {
			await Promise.resolve();
		});

		expect(createSpy).toHaveBeenCalledTimes(1);
		const [type, properties] = createSpy.mock.calls[0] as unknown as [
			string,
			Record<string, unknown>,
		];
		expect(type).toBe("brainstorm/Object/v1");
		expect(properties.wantsGift).toBe("no");
		expect("giftNote" in properties).toBe(false);
	});
});
