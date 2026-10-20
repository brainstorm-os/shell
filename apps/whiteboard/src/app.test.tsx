// @vitest-environment jsdom
/**
 * 9.17.21 — React chrome smoke test. Renders `<WhiteboardApp>` in standalone
 * mode (no `window.brainstorm`) and asserts the React-owned chrome mounts:
 * the `.app-header` (with the object ⋯ menu LAST in the right group), the
 * authoring toolbar, the zoom controls, the sidebar, and the ref-mounted
 * imperative canvas surface. The canvas draw loop / interaction logic stays
 * covered by the `logic/ui/render` suites; this verifies the React wrapper
 * wires the engine behind the ref and renders all surrounding chrome.
 */

import { afterEach, describe, expect, it } from "vitest";
import { WhiteboardApp } from "./app";
import { flush, renderInto } from "./test/render";

let handle: Awaited<ReturnType<typeof renderInto>> | null = null;

afterEach(async () => {
	await handle?.unmount();
	handle = null;
	window.brainstorm = undefined;
	Reflect.deleteProperty(window, "__brainstormWhiteboardDev");
});

describe("WhiteboardApp chrome (React)", () => {
	it("mounts the .app-header with the glass surface", async () => {
		handle = await renderInto(<WhiteboardApp />);
		await flush();
		const header = handle.container.querySelector<HTMLElement>(".app-header");
		expect(header).not.toBeNull();
	});

	it("renders the authoring toolbar with all five tools", async () => {
		handle = await renderInto(<WhiteboardApp />);
		await flush();
		const tools = handle.container.querySelectorAll(".whiteboard__tools .whiteboard__tool");
		expect(tools.length).toBe(5);
		// Select is the default active tool.
		const pressed = handle.container.querySelector('.whiteboard__tool[aria-pressed="true"]');
		expect(pressed).not.toBeNull();
	});

	it("renders the floating zoom controls", async () => {
		handle = await renderInto(<WhiteboardApp />);
		await flush();
		expect(handle.container.querySelector(".whiteboard__zoom")).not.toBeNull();
		const level = handle.container.querySelector(".whiteboard__zoom-level");
		expect(level?.textContent).toBe("100%");
	});

	it("places the object ⋯ menu LAST in the header right group", async () => {
		handle = await renderInto(<WhiteboardApp />);
		await flush();
		const right = handle.container.querySelector<HTMLElement>(".app-header__right");
		expect(right).not.toBeNull();
		const last = right?.lastElementChild;
		expect(last?.classList.contains("bs-object-menu__more")).toBe(true);
	});

	it("mounts the imperative canvas surface behind the React ref", async () => {
		handle = await renderInto(<WhiteboardApp />);
		await flush();
		const host = handle.container.querySelector(".whiteboard__canvas-host");
		expect(host).not.toBeNull();
		// The engine fills the host with its canvas-wrap on mount.
		expect(host?.querySelector(".whiteboard__canvas-wrap")).not.toBeNull();
		expect(host?.querySelector(".whiteboard__nodes")).not.toBeNull();
	});

	it("installs the dev hook so the canvas pipeline is drivable headless", async () => {
		handle = await renderInto(<WhiteboardApp />);
		await flush();
		expect(typeof window.__brainstormWhiteboardDev?.nodeIds).toBe("function");
	});

	it("renders the board-list sidebar and the header new-board button", async () => {
		handle = await renderInto(<WhiteboardApp />);
		await flush();
		expect(handle.container.querySelector(".whiteboard__nav")).not.toBeNull();
		expect(handle.container.querySelector('[data-testid="whiteboard-new-board"]')).not.toBeNull();
		expect(handle.container.querySelector(".whiteboard__search .bs-searchbar")).not.toBeNull();
	});
});

describe("WhiteboardApp — auto-hide sidebar (7.15)", () => {
	afterEach(() => {
		document.documentElement.removeAttribute("data-bs-autohide-sidebars");
		localStorage.removeItem("whiteboard.navOpen");
	});

	it("without the preference, a collapsed board list leaves the tab order", async () => {
		localStorage.setItem("whiteboard.navOpen", "false");
		handle = await renderInto(<WhiteboardApp />);
		await flush();
		const nav = handle.container.querySelector(".whiteboard__nav");
		expect(nav?.hasAttribute("inert")).toBe(true);
		expect(nav?.hasAttribute("data-bs-autohide")).toBe(false);
		expect(handle.container.querySelector(".bs-autohide-edge")).toBeNull();
	});

	it("with the preference on, a collapsed board list becomes a hidden overlay with an edge hot-zone", async () => {
		document.documentElement.setAttribute("data-bs-autohide-sidebars", "on");
		localStorage.setItem("whiteboard.navOpen", "false");
		handle = await renderInto(<WhiteboardApp />);
		await flush();
		const nav = handle.container.querySelector(".whiteboard__nav");
		expect(nav?.getAttribute("data-bs-autohide")).toBe("hidden");
		expect(nav?.hasAttribute("inert")).toBe(true);
		expect(handle.container.querySelector(".bs-autohide-edge")).not.toBeNull();
	});
});
