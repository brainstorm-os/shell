// @vitest-environment jsdom
/**
 * Start-menu app grid glue: renders every installed app, filters by query,
 * launches on click (and on Enter in the search box), and surfaces an empty
 * state. The 2-D roving keyboard model lives in `@brainstorm-os/sdk/a11y`
 * (`useCompositeKeyboard`, separately tested); here we cover the React + IPC
 * wiring. App ranking is covered by `grouped-results.test.ts`.
 */

import { getEscapeStack, installEscapeHandler } from "@brainstorm-os/sdk/a11y";
import { BrainstormMenuProvider } from "@brainstorm-os/sdk/menus";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstalledApp } from "../../preload";
import { AppGrid } from "./app-grid";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const APPS: InstalledApp[] = [
	{ id: "app.alpha", name: "Alpha", version: "1.0.0", description: "first", hasIcon: false },
	{ id: "app.bravo", name: "Bravo", version: "1.0.0", description: "second", hasIcon: false },
	{ id: "app.cobalt", name: "Cobalt", version: "1.0.0", description: "third", hasIcon: false },
] as unknown as InstalledApp[];

const flush = () => act(async () => await Promise.resolve());

describe("AppGrid", () => {
	let host: HTMLDivElement;
	let root: Root;
	let uninstallEscape: () => void;
	let onClose: Mock<() => void>;
	let onLaunch: Mock<(id: string) => void>;
	let onPin: Mock<(app: InstalledApp) => void>;
	let onUnpin: Mock<(appId: string) => void>;

	beforeEach(() => {
		(window as unknown as { brainstorm: unknown }).brainstorm = {
			apps: {
				listInstalled: () => Promise.resolve(APPS),
				listRunning: () => Promise.resolve(["app.bravo"]),
				onRunningChanged: () => () => undefined,
				iconUrl: (id: string) => `brainstorm://app-icon/${id}`,
			},
		};
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		uninstallEscape = installEscapeHandler(getEscapeStack());
		onClose = vi.fn<() => void>();
		onLaunch = vi.fn<(id: string) => void>();
		onPin = vi.fn<(app: InstalledApp) => void>();
		onUnpin = vi.fn<(appId: string) => void>();
	});

	afterEach(() => {
		uninstallEscape();
		act(() => root.unmount());
		host.remove();
	});

	async function mount(open: boolean): Promise<void> {
		await act(async () => {
			root.render(
				<BrainstormMenuProvider>
					<AppGrid
						open={open}
						onClose={onClose}
						onLaunch={onLaunch}
						onPin={onPin}
						onUnpin={onUnpin}
						pinnedAppIds={new Set()}
					/>
				</BrainstormMenuProvider>,
			);
		});
		await flush();
		await flush();
	}

	const cells = () => Array.from(document.querySelectorAll<HTMLElement>("[data-app-grid-cell]"));
	const labels = () => cells().map((c) => c.querySelector(".app-grid__label")?.textContent ?? "");
	const cellByLabel = (label: string) =>
		cells().find((c) => c.querySelector(".app-grid__label")?.textContent === label);
	const search = () => document.querySelector<HTMLInputElement>('[data-testid="app-grid-search"]');

	it("renders nothing when closed", async () => {
		await mount(false);
		expect(document.querySelector(".app-grid")).toBeNull();
	});

	it("lists every installed app when open", async () => {
		await mount(true);
		expect(labels()).toEqual(["Alpha", "Bravo", "Cobalt"]);
	});

	it("filters apps by the search query", async () => {
		await mount(true);
		const input = search();
		if (!input) throw new Error("no search input");
		await act(async () => {
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
			setter?.call(input, "cob");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(labels()).toEqual(["Cobalt"]);
	});

	it("launches an app on click and closes", async () => {
		await mount(true);
		const bravo = cellByLabel("Bravo");
		if (!bravo) throw new Error("no Bravo cell");
		await act(async () => bravo.click());
		expect(onLaunch).toHaveBeenCalledWith("app.bravo");
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("launches the top-ranked app on Enter in the search box", async () => {
		await mount(true);
		const input = search();
		if (!input) throw new Error("no search input");
		await act(async () => {
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
			setter?.call(input, "bra");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		});
		expect(onLaunch).toHaveBeenCalledWith("app.bravo");
	});

	it("shows the empty state when no app matches", async () => {
		await mount(true);
		const input = search();
		if (!input) throw new Error("no search input");
		await act(async () => {
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
			setter?.call(input, "zzzzz");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(cells()).toHaveLength(0);
		expect(document.querySelector(".app-grid__empty")).not.toBeNull();
	});
});
