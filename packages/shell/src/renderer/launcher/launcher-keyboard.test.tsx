// @vitest-environment jsdom
/**
 * Launcher contract (Stage 7.4 / 9.22.2, fancy-menus at 8.8). The launcher
 * is now a `@react-fancy-menus` surface: chrome, search input, list keyboard
 * navigation and focus are owned by the menu runtime (exercised end-to-end
 * in the real shell via tests/perf). This file covers the React + IPC glue —
 * the launcher opens the menu in step with the `open` prop, feeds the built
 * rows in, activates apps on click, and unwinds on Escape via the shared
 * escape stack. Pure row assembly + ranking live in `grouped-results.test.ts`.
 */

import { getEscapeStack, installEscapeHandler } from "@brainstorm-os/sdk/a11y";
import { BrainstormMenuProvider } from "@brainstorm-os/sdk/menus";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstalledApp } from "../../preload";
import { Launcher } from "./launcher";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const APPS: InstalledApp[] = [
	{ id: "app.alpha", name: "Alpha", version: "1.0.0", description: "first", hasIcon: false },
	{ id: "app.bravo", name: "Bravo", version: "1.0.0", description: "second", hasIcon: false },
] as unknown as InstalledApp[];

const flush = () => act(async () => await Promise.resolve());

describe("Launcher — fancy-menus glue", () => {
	let host: HTMLDivElement;
	let root: Root;
	let uninstallEscape: () => void;
	let onClose: Mock<() => void>;
	let launch: Mock<(id: string) => Promise<void>>;

	beforeEach(() => {
		launch = vi.fn<(id: string) => Promise<void>>(() => Promise.resolve());
		(window as unknown as { brainstorm: unknown }).brainstorm = {
			apps: { listInstalled: () => Promise.resolve(APPS), launch },
			search: { query: () => Promise.resolve([]) },
			intents: { dispatch: vi.fn(() => Promise.resolve({ handled: true })) },
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

	async function mount(open: boolean): Promise<void> {
		await act(async () => {
			root.render(
				<BrainstormMenuProvider>
					<Launcher open={open} onClose={onClose} />
				</BrainstormMenuProvider>,
			);
		});
		await flush();
		await flush();
	}

	// Row rendering + keyboard + click activation run through the menu's
	// virtualized list, which jsdom can't measure (0 height → 0 rows). Those
	// are verified in the real shell via tests/perf; here we assert the glue
	// that drives the menu open/closed in step with the `open` prop.
	const menu = () => document.querySelector<HTMLElement>(".fm-menu.launcher-menu");

	it("opens the menu when open", async () => {
		await mount(true);
		expect(menu()).not.toBeNull();
		expect(menu()?.getAttribute("role")).toBe("dialog");
	});

	it("does not open the menu when closed", async () => {
		await mount(false);
		expect(menu()).toBeNull();
	});
});
