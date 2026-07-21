// @vitest-environment jsdom
/**
 * Delete-path test for the saved-forms sidebar. The per-item ⋯ menu opens an
 * anchored menu (mocked so we can grab the "Delete form" row's onSelect),
 * which raises a confirm dialog; confirming delegates to the capability-gated
 * vault `entities.delete(id)`. Cancelling must NOT delete.
 */

import { LAYOUT_TYPE_URL } from "@brainstorm-os/sdk-types";
import { type AnchoredMenuItem, openAnchoredMenu } from "@brainstorm-os/sdk/object-menu";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FormDesignerApp } from "./app";

vi.mock("@brainstorm-os/sdk/object-menu", () => ({
	openAnchoredMenu: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class StubResizeObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

type StubEntity = { id: string; type: string; properties: Record<string, unknown> };

const deleteSpy = vi.fn(() => Promise.resolve());

function layoutRow(id: string, name: string): StubEntity {
	return {
		id,
		type: LAYOUT_TYPE_URL,
		properties: { name, targetType: "brainstorm/Object/v1", cells: [] },
	};
}

function installShell(entities: StubEntity[]): void {
	(window as { brainstorm?: unknown }).brainstorm = {
		on: (_event: string, handler: () => void) => {
			handler();
			return { unsubscribe: () => {} };
		},
		services: {
			vaultEntities: {
				list: () => Promise.resolve({ entities, links: [] }),
				onChange: () => ({ unsubscribe: () => {} }),
			},
			entities: {
				get: vi.fn(() => Promise.resolve(null)),
				create: vi.fn(() => Promise.resolve({ id: "new" })),
				update: vi.fn(() => Promise.resolve(null)),
				delete: deleteSpy,
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
	await act(async () => {
		root?.render(<FormDesignerApp />);
	});
	await act(async () => {
		await Promise.resolve();
	});
	return container;
}

function capturedDeleteItem(): AnchoredMenuItem {
	const calls = vi.mocked(openAnchoredMenu).mock.calls;
	const lastCall = calls[calls.length - 1];
	const items = lastCall?.[1] as AnchoredMenuItem[];
	const item = items.find((i) => i.destructive);
	if (!item) throw new Error("no destructive delete item in the form-item menu");
	return item;
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
	deleteSpy.mockClear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("FormDesignerApp saved-form delete", () => {
	it("opens a per-item ⋯ menu that confirms then delegates to entities.delete", async () => {
		installShell([layoutRow("f1", "Intake form")]);
		const el = await renderApp();

		const more = el.querySelector<HTMLButtonElement>(".fd-sidebar__item-more");
		expect(more).not.toBeNull();
		await act(async () => {
			more?.click();
		});
		expect(vi.mocked(openAnchoredMenu)).toHaveBeenCalled();

		// Selecting "Delete form" raises the confirm dialog — nothing deleted yet.
		await act(async () => {
			capturedDeleteItem().onSelect?.();
		});
		expect(deleteSpy).not.toHaveBeenCalled();
		const dialog = document.querySelector<HTMLElement>(".bs-popover");
		expect(dialog).not.toBeNull();

		// Confirm deletes via the vault service.
		const confirmBtn = dialog?.querySelector<HTMLButtonElement>(".bs-btn--danger");
		await act(async () => {
			confirmBtn?.click();
		});
		await act(async () => {
			await Promise.resolve();
		});
		expect(deleteSpy).toHaveBeenCalledWith("f1");
	});

	it("cancel in the confirm dialog does NOT delete", async () => {
		installShell([layoutRow("f1", "Intake form")]);
		const el = await renderApp();

		const more = el.querySelector<HTMLButtonElement>(".fd-sidebar__item-more");
		await act(async () => {
			more?.click();
		});
		await act(async () => {
			capturedDeleteItem().onSelect?.();
		});

		const dialog = document.querySelector<HTMLElement>(".bs-popover");
		const cancelBtn = dialog?.querySelector<HTMLButtonElement>(".bs-btn--neutral");
		await act(async () => {
			cancelBtn?.click();
		});
		expect(deleteSpy).not.toHaveBeenCalled();
		expect(document.querySelector(".bs-popover")).toBeNull();
	});
});
