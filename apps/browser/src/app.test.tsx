// @vitest-environment jsdom
/**
 * Chrome wiring for the recently-closed reopen affordance: the toolbar button
 * opens the shared anchored menu with the right entries, and a selection drives
 * `webView.open` for the restored tab. The pure projection + reducer are
 * covered in `logic/recently-closed.test.ts`; this exercises the React glue.
 */

import type { WebViewClient } from "@brainstorm/sdk-types";
import { openAnchoredMenu } from "@brainstorm/sdk/object-menu";
import { type ReactNode, act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserApp } from "./app";

vi.mock("@brainstorm/sdk/menus", () => ({
	mountMenuHost: vi.fn(() => () => {}),
	closeTypeaheadMenu: vi.fn(),
}));
vi.mock("@brainstorm/sdk/object-menu", () => ({ openAnchoredMenu: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no ResizeObserver; the chrome uses one to report the web-region rect.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
	observe() {}
	unobserve() {}
	disconnect() {}
};

type FakeWebView = WebViewClient & {
	opened: Array<{ tabId: string; url: string }>;
	closed: string[];
};

function fakeWebView(): FakeWebView {
	const opened: Array<{ tabId: string; url: string }> = [];
	const closed: string[] = [];
	const noop = () => Promise.resolve();
	return {
		opened,
		closed,
		open: (tabId: string, url: string) => {
			opened.push({ tabId, url });
			return Promise.resolve();
		},
		navigate: noop,
		back: noop,
		forward: noop,
		reload: noop,
		stop: noop,
		close: (tabId: string) => {
			closed.push(tabId);
			return Promise.resolve();
		},
		activate: noop,
		setBounds: noop,
		findInPage: noop,
		stopFind: noop,
		capture: () => Promise.resolve(null),
		setSitePermission: noop,
		clearBrowsingData: () => Promise.resolve(),
		setSiteTrust: () => Promise.resolve(),
		isSiteTrusted: () => Promise.resolve(false),
		onEvent: () => () => {},
	} as FakeWebView;
}

let root: Root;
let container: HTMLDivElement;
let webView: FakeWebView;

beforeEach(() => {
	webView = fakeWebView();
	(window as { brainstorm?: unknown }).brainstorm = {
		services: { webView, entities: { create: () => Promise.resolve({ id: "x", type: "t" }) } },
	};
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	(window as { brainstorm?: unknown }).brainstorm = undefined;
	vi.mocked(openAnchoredMenu).mockClear();
});

async function render(node: ReactNode): Promise<void> {
	await act(async () => {
		root.render(node);
	});
}

function historyButton(): HTMLButtonElement {
	const el = container.querySelector<HTMLButtonElement>('button[aria-label="History"]');
	if (!el) throw new Error("history button missing");
	return el;
}

describe("fresh session chrome", () => {
	it("opens exactly one tab on a fresh vault (no persisted session)", async () => {
		await render(<BrowserApp />);
		// createSession mints a single blank tab; with no BrowsingSession/v1 row
		// to restore, the chrome must stay on that one tab (two tabs at launch
		// only ever come from a persisted, restored session — never a fresh boot).
		expect(container.querySelectorAll(".browser__tab").length).toBe(1);
	});

	it("hides the security badge on a blank new tab (no remote origin)", async () => {
		await render(<BrowserApp />);
		// The connection badge has no meaningful state for about:blank, so it must
		// not render (a bare dot with no icon reads as a stray/placeholder element).
		expect(container.querySelector(".browser__security")).toBeNull();
	});

	it("shows a lock badge once a secure page loads", async () => {
		await render(<BrowserApp />);
		const omnibox = container.querySelector<HTMLInputElement>(".browser__omnibox");
		if (!omnibox) throw new Error("omnibox missing");
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
		setter?.call(omnibox, "https://example.test");
		await act(async () => {
			omnibox.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			omnibox.closest("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		});
		const badge = container.querySelector<HTMLElement>(".browser__security");
		expect(badge).not.toBeNull();
		expect(badge?.classList.contains("browser__security--secure")).toBe(true);
		// A real glyph, not an empty dot.
		expect(badge?.querySelector("svg")).not.toBeNull();
	});
});

describe("recently-closed reopen affordance", () => {
	it("shows an empty state while nothing was closed or visited", async () => {
		await render(<BrowserApp />);
		await act(async () => historyButton().click());
		const items = vi.mocked(openAnchoredMenu).mock.calls[0]?.[1] ?? [];
		expect(items).toEqual([{ label: "No history yet", disabled: true }]);
	});

	it("opens the anchored menu listing closed tabs and reopens the picked one", async () => {
		await render(<BrowserApp />);

		// Open a second tab, navigate it, then close it → it lands in the ring.
		await act(async () => {
			window.dispatchEvent(new CustomEvent("brainstorm:tab-command", { detail: { kind: "new-tab" } }));
		});
		const omnibox = container.querySelector<HTMLInputElement>(".browser__omnibox");
		if (!omnibox) throw new Error("omnibox missing");
		const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
		setter?.call(omnibox, "https://example.test");
		await act(async () => {
			omnibox.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			omnibox.closest("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
		});
		const closeBtn = container.querySelector<HTMLButtonElement>(
			".browser__tab--active .browser__tab-close",
		);
		if (!closeBtn) throw new Error("close button missing");
		await act(async () => closeBtn.click());

		await act(async () => historyButton().click());
		expect(openAnchoredMenu).toHaveBeenCalledTimes(1);
		const items = vi.mocked(openAnchoredMenu).mock.calls[0]?.[1] ?? [];
		expect(items[0]).toMatchObject({ label: "Recently closed", section: true });
		const entry = items.find((i) => i.label === "https://example.test");
		expect(entry).toBeDefined();

		const openedBefore = webView.opened.length;
		await act(async () => entry?.onSelect?.());
		const reopened = webView.opened.slice(openedBefore);
		expect(reopened.some((o: { url: string }) => o.url === "https://example.test")).toBe(true);
	});
});
