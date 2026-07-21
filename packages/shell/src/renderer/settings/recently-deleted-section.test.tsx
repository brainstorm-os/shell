// @vitest-environment jsdom
/**
 * 9.8.8 — Settings → Recently Deleted. Drives the retention select
 * (load → display → change → persist round-trip), the live count line,
 * and the open-Bin jump through a stubbed `window.brainstorm`.
 */

import {
	BrainstormMenuProvider,
	CONTEXT_MENU_ID,
	type ContextMenuItem,
	closeContextMenu,
	getActiveMenuStore,
} from "@brainstorm-os/sdk/menus";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Stub = {
	bin: {
		list: Mock;
		getRetention: Mock;
		setRetention: Mock;
	};
	dashboard: { on: Mock };
};

let stub: Stub;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	stub = {
		bin: {
			list: vi.fn().mockResolvedValue([
				{ id: "a", type: "io.x/Note/v1", title: "Alpha", icon: null, deletedAt: 1000 },
				{ id: "b", type: "io.x/Note/v1", title: "Bravo", icon: null, deletedAt: 2000 },
			]),
			getRetention: vi.fn().mockResolvedValue(30),
			setRetention: vi.fn().mockResolvedValue(90),
		},
		dashboard: { on: vi.fn().mockReturnValue(() => undefined) },
	};
	(window as unknown as { brainstorm: unknown }).brainstorm = stub;
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});

afterEach(() => {
	act(() => closeContextMenu());
	act(() => root.unmount());
	host.remove();
	(window as unknown as { brainstorm?: unknown }).brainstorm = undefined;
});

async function mount(onOpenBin?: () => void) {
	const { RecentlyDeletedSection } = await import("./recently-deleted-section");
	await act(async () => {
		root.render(
			<BrainstormMenuProvider>
				<RecentlyDeletedSection {...(onOpenBin ? { onOpenBin } : {})} />
			</BrainstormMenuProvider>,
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
}

function retentionTrigger(): HTMLButtonElement {
	const trigger = host.querySelector<HTMLButtonElement>(".bs-select");
	if (!trigger) throw new Error("retention select missing");
	return trigger;
}

/** Items of the open select popup — the shared select control routes through
 *  the fancy-menus store (see `@brainstorm-os/sdk/select-menu` tests). */
function openItems(menuLabel: string): ContextMenuItem[] {
	const store = getActiveMenuStore();
	const open = store?.getAll().find((m) => m.id === `${CONTEXT_MENU_ID}:${menuLabel}`);
	if (!open) throw new Error(`menu ${menuLabel} not open`);
	return (open.param.data as { items: ContextMenuItem[] }).items;
}

describe("RecentlyDeletedSection", () => {
	it("loads + displays the persisted retention window", async () => {
		await mount();
		expect(stub.bin.getRetention).toHaveBeenCalledTimes(1);
		expect(retentionTrigger().querySelector(".bs-select__value")?.textContent).toBe("30 days");
	});

	it("changing the select persists via bin:set-retention and mirrors the applied value", async () => {
		await mount();
		act(() => retentionTrigger().click());
		const items = openItems("Keep deleted items");
		const ninety = items.find((item) => item.label === "90 days");
		expect(ninety).toBeDefined();
		await act(async () => {
			ninety?.onSelect?.();
		});
		expect(stub.bin.setRetention).toHaveBeenCalledWith(90);
		await act(async () => {
			await Promise.resolve();
		});
		expect(retentionTrigger().querySelector(".bs-select__value")?.textContent).toBe("90 days");
	});

	it("shows the live deleted-items count from bin:list", async () => {
		await mount();
		expect(stub.bin.list).toHaveBeenCalled();
		expect(host.textContent).toContain("2 items can be restored");
	});

	it("the open button jumps into the Bin overlay", async () => {
		const onOpenBin = vi.fn();
		await mount(onOpenBin);
		const button = [...host.querySelectorAll("button")].find((b) =>
			b.textContent?.includes("Open Recently Deleted"),
		);
		expect(button).toBeDefined();
		await act(async () => {
			button?.click();
		});
		expect(onOpenBin).toHaveBeenCalledTimes(1);
	});
});
