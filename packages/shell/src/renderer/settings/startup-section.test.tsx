import { StartupPageKind } from "@brainstorm-os/protocol/shell-prefs";
// @vitest-environment jsdom
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StartupSection } from "./startup-section";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const setStartupPage = vi.fn(() => Promise.resolve());
const searchQuery = vi.fn(() =>
	Promise.resolve([
		{
			entityId: "e1",
			title: "Roadmap",
			type: "x",
			ownerAppId: "a",
			snippet: "",
			score: 1,
			updatedAt: 0,
		},
	]),
);
let startupPage: unknown = { kind: StartupPageKind.Dashboard };

vi.mock("@brainstorm-os/sdk/object-menu", () => ({
	openAnchoredMenu: vi.fn(
		(_point: unknown, items: Array<{ label?: string; onSelect?: () => void }>) => {
			items[0]?.onSelect?.();
		},
	),
}));

function dashboardMock() {
	return {
		snapshot: () => Promise.resolve({ startupPage }),
		on: () => () => undefined,
		setStartupPage,
	};
}

describe("StartupSection — keep running in the background (7.16)", () => {
	let host: HTMLDivElement;
	let root: Root;

	function install(supported: boolean, keepRunning = false) {
		const setKeepRunning = vi.fn((next: boolean) =>
			Promise.resolve({ supported, keepRunning: next }),
		);
		(window as unknown as { brainstorm: unknown }).brainstorm = {
			background: {
				getPrefs: () => Promise.resolve({ supported, keepRunning }),
				setKeepRunning,
			},
			dashboard: dashboardMock(),
			search: { query: searchQuery },
		};
		return setKeepRunning;
	}

	beforeEach(() => {
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
	});

	afterEach(() => {
		act(() => root.unmount());
		host.remove();
		(window as unknown as { brainstorm?: unknown }).brainstorm = undefined;
	});

	const toggle = () =>
		host.querySelector<HTMLInputElement>('input[aria-label="Keep running in the background"]');

	it("is hidden where the platform keeps windowless apps alive anyway (macOS)", async () => {
		install(false);
		await act(async () => root.render(<StartupSection />));
		expect(toggle()).toBeNull();
	});

	it("is off by default and writes the choice", async () => {
		const setKeepRunning = install(true);
		await act(async () => root.render(<StartupSection />));
		expect(toggle()?.checked).toBe(false);
		await act(async () => toggle()?.click());
		expect(setKeepRunning).toHaveBeenCalledWith(true);
		expect(toggle()?.checked).toBe(true);
	});
});

describe("StartupSection — startup page (7.17)", () => {
	let host: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		setStartupPage.mockClear();
		(window as unknown as { brainstorm: unknown }).brainstorm = {
			background: { getPrefs: () => Promise.resolve({ supported: false, keepRunning: false }) },
			dashboard: dashboardMock(),
			search: { query: searchQuery },
		};
		host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
	});

	afterEach(() => {
		act(() => root.unmount());
		host.remove();
		startupPage = { kind: StartupPageKind.Dashboard };
		(window as unknown as { brainstorm?: unknown }).brainstorm = undefined;
	});

	it("shows the saved object and picks a new one from search results", async () => {
		startupPage = { kind: StartupPageKind.Object, entityId: "old", title: "Old plan" };
		await act(async () => root.render(<StartupSection />));
		expect(host.textContent).toContain("Opens Old plan.");
		const field = host.querySelector<HTMLInputElement>(
			'[data-testid="settings-startup-object-search"]',
		);
		expect(field).not.toBeNull();
		await act(async () => {
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
			setter?.call(field, "road");
			field?.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			host.querySelector("form")?.requestSubmit();
		});
		expect(searchQuery).toHaveBeenCalledWith({ text: "road", limit: 8 });
		expect(setStartupPage).toHaveBeenCalledWith({
			kind: StartupPageKind.Object,
			entityId: "e1",
			title: "Roadmap",
		});
	});

	it("hides the object picker for the dashboard default", async () => {
		await act(async () => root.render(<StartupSection />));
		expect(host.querySelector('[data-testid="settings-startup-object-search"]')).toBeNull();
	});
});
