// @vitest-environment jsdom
/**
 * PreviewApp structure tests — the React chrome rewrite (9.20.12). Covers the
 * shared `.app-header` contract (⋯ LAST in __right), the inspector toggle, the
 * source chip, the filmstrip listbox + composite-keyboard navigation, and that
 * the overflow ⋯ opens through the fancy-menus anchored menu (no native
 * `<select>` / bespoke dropdown).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openAnchoredMenu } from "@brainstorm/sdk/object-menu";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewApp } from "./app";
import { _resetPreviewRegistryForTests } from "./logic/registry";
import { flush, renderInto } from "./test/render";
import { PreviewContextKind } from "./types/preview-context";

vi.mock("@brainstorm/sdk/menus", () => ({
	mountMenuHost: vi.fn(),
	MenuAlign: { Start: "start", End: "end" },
}));
vi.mock("@brainstorm/sdk/object-menu", () => ({ openAnchoredMenu: vi.fn() }));

beforeEach(() => {
	// No renderers registered — the stage shows the "renderer not wired" pane
	// rather than fetching real bytes, keeping these chrome tests hermetic.
	_resetPreviewRegistryForTests();
	(window as { brainstorm?: unknown }).brainstorm = undefined;
	// Panel-open prefs persist per storage scope (sidebar in localStorage,
	// inspector in sessionStorage); clear both so each test starts from the
	// documented defaults instead of a previous test's toggled state.
	localStorage.clear();
	sessionStorage.clear();
});

afterEach(() => {
	vi.mocked(openAnchoredMenu).mockClear();
	(window as { brainstorm?: unknown }).brainstorm = undefined;
});

const SIBLINGS = [
	{ id: "a", name: "a.png", mime: "image/png", url: "data:image/png;base64,iVBOR-a" },
	{ id: "b", name: "b.png", mime: "image/png", url: "data:image/png;base64,iVBOR-b" },
	{ id: "c", name: "c.png", mime: "image/png", url: "data:image/png;base64,iVBOR-c" },
];

async function applyGallery(): Promise<void> {
	await act(async () => {
		window.__previewHost?.applyContext(
			{ kind: PreviewContextKind.Folder, label: "Shots" },
			SIBLINGS,
			"a",
		);
	});
	await flush();
}

/** The overflow ⋯ only renders when it has at least one item — today that's
 *  "Save a copy", which needs the `files` service + an active file. Stamp a
 *  files service so the ⋯ structure tests have something to overflow. */
function withFilesService(): void {
	(window as { brainstorm?: unknown }).brainstorm = {
		services: { files: { requestSave: async () => null, write: async () => undefined } },
	};
}

describe("PreviewApp", () => {
	it("renders the app-header with the ⋯ as the LAST element in __right", async () => {
		withFilesService();
		const { container, unmount } = await renderInto(<PreviewApp />);
		await applyGallery();
		const header = container.querySelector('[data-testid="app-header"]');
		expect(header?.classList.contains("app-header")).toBe(true);
		const right = container.querySelector(".app-header__right");
		const last = right?.lastElementChild;
		expect(last?.classList.contains("bs-object-menu__more")).toBe(true);
		await unmount();
	});

	it("hides the overflow ⋯ when it would have no items (no Save a copy)", async () => {
		const { container, unmount } = await renderInto(<PreviewApp />);
		await flush();
		expect(container.querySelector(".app-header__right .bs-object-menu__more")).toBeNull();
		await unmount();
	});

	it("shows the honest empty state and no native select / dropdown", async () => {
		const { container, unmount } = await renderInto(<PreviewApp />);
		await flush();
		expect(container.querySelector(".bs-empty-state")).not.toBeNull();
		expect(container.querySelector("select")).toBeNull();
		expect(container.querySelector(".preview__filename")?.textContent).toBe("");
		await unmount();
	});

	it("opens the overflow ⋯ through the fancy-menus anchored menu", async () => {
		withFilesService();
		const { container, unmount } = await renderInto(<PreviewApp />);
		await applyGallery();
		await act(async () => {
			container.querySelector<HTMLButtonElement>(".app-header__right .bs-object-menu__more")?.click();
		});
		expect(openAnchoredMenu).toHaveBeenCalled();
		await unmount();
	});

	it("toggles the inspector via the header button (collapses the panel)", async () => {
		const { container, unmount } = await renderInto(<PreviewApp />);
		await flush();
		const root = container.querySelector(".preview");
		const toggle = container.querySelector<HTMLButtonElement>(
			'.app-header__right [data-testid="inspector-toggle"]',
		);
		// Inspector defaults CLOSED on first run (no stored pref).
		expect(toggle?.getAttribute("aria-pressed")).toBe("false");
		expect(root?.classList.contains("preview--inspector-collapsed")).toBe(true);
		await act(async () => toggle?.click());
		expect(toggle?.getAttribute("aria-pressed")).toBe("true");
		expect(root?.classList.contains("preview--inspector-collapsed")).toBe(false);
		await unmount();
	});

	it("shows the library sidebar by default and toggles it from the header-right button", async () => {
		const { container, unmount } = await renderInto(<PreviewApp />);
		await flush();
		const root = container.querySelector(".preview");
		// Launched with nothing to show → the sidebar defaults open.
		expect(container.querySelector(".preview__sidebar")).not.toBeNull();
		expect(root?.classList.contains("preview--sidebar-collapsed")).toBe(false);
		// Panel toggles live in the header-right group in every app; the
		// sidebar toggle is the first control there (before the inspector toggle).
		const right = container.querySelector(".app-header__right");
		const toggle = right?.querySelector<HTMLButtonElement>('[data-testid="sidebar-toggle"]');
		expect(toggle?.classList.contains("bs-panel-toggle")).toBe(true);
		expect(right?.firstElementChild).toBe(toggle);
		await act(async () => toggle?.click());
		expect(root?.classList.contains("preview--sidebar-collapsed")).toBe(true);
		await unmount();
	});

	it("fills the viewport: the body lives under the fixed app-header", async () => {
		const { container, unmount } = await renderInto(<PreviewApp />);
		await flush();
		expect(container.querySelector("#preview-root.preview")).toBeTruthy();
		expect(container.querySelector(".preview__body")).toBeTruthy();
		expect(container.querySelector(".preview__inspector")).toBeTruthy();
		await unmount();
	});

	it("renders the filmstrip as a horizontal listbox once a gallery is applied", async () => {
		const { container, unmount } = await renderInto(<PreviewApp />);
		await flush();
		await applyGallery();

		const strip = container.querySelector<HTMLElement>(".preview__filmstrip");
		expect(strip?.getAttribute("role")).toBe("listbox");
		expect(strip?.getAttribute("aria-orientation")).toBe("horizontal");
		const thumbs = strip?.querySelectorAll<HTMLElement>(".preview__filmstrip-item");
		expect(thumbs).toHaveLength(3);
		expect(thumbs?.[0]?.getAttribute("role")).toBe("option");
		expect(thumbs?.[0]?.getAttribute("tabindex")).toBe("0");
		expect(thumbs?.[0]?.getAttribute("aria-selected")).toBe("true");
		expect(window.__previewHost?.getCursor()).toBe(0);

		// Source chip reflects the applied context.
		expect(container.querySelector(".preview__source-chip-label")?.textContent).toBe(
			"From folder: Shots",
		);
		await unmount();
	});

	it("ArrowRight on the filmstrip roves to the next file (same as click)", async () => {
		const { container, unmount } = await renderInto(<PreviewApp />);
		await flush();
		await applyGallery();
		const strip = container.querySelector<HTMLElement>(".preview__filmstrip");
		expect(window.__previewHost?.getCursor()).toBe(0);
		await act(async () => {
			strip?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
		});
		expect(window.__previewHost?.getCursor()).toBe(1);
		expect(container.querySelector(".preview__filename")?.textContent).toBe("b.png");
		await unmount();
	});

	it("clicking a filmstrip thumb navigates to that file", async () => {
		const { container, unmount } = await renderInto(<PreviewApp />);
		await flush();
		await applyGallery();
		const thumbs = container.querySelectorAll<HTMLButtonElement>(".preview__filmstrip-item");
		await act(async () => thumbs[2]?.click());
		expect(window.__previewHost?.getCursor()).toBe(2);
		expect(container.querySelector(".preview__filename")?.textContent).toBe("c.png");
		await unmount();
	});
});

/** F-317 layout regression. jsdom computes no grid layout, so the pane
 *  geometry is pinned at the stylesheet level: the collapsed sidebar is
 *  `display: none`, which removes its grid item — an auto-placed
 *  `.preview__main` then slides into the shrink-wrapping `auto` column and
 *  the whole pane collapses to content width (empty state hugging the left
 *  edge, inspector "docked" mid-window). Verified in a real browser via the
 *  repro in the F-317 fix; these assertions keep the two load-bearing
 *  declarations from regressing. */
describe("PreviewApp layout contract (F-317)", () => {
	const css = readFileSync(join(__dirname, "styles.css"), "utf8");
	const rule = (selector: string): string => {
		const start = css.indexOf(`\n${selector} {`);
		expect(start, `styles.css must declare \`${selector}\``).toBeGreaterThan(-1);
		return css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
	};

	it("pins .preview__main to the 1fr grid column so a hidden sidebar can't shrink-wrap it", () => {
		expect(rule(".preview__main")).toContain("grid-column: 2");
	});

	it("docks the inspector to the right edge of the pane (fleet glass-overlay pattern)", () => {
		const inspector = rule(".preview__inspector");
		expect(inspector).toContain("inset-inline-end: 0");
		expect(inspector).toContain("position: absolute");
	});

	it("renders the sidebar then main as the grid children, inspector inside the body", async () => {
		const { container, unmount } = await renderInto(<PreviewApp />);
		await flush();
		const root = container.querySelector(".preview");
		expect(root?.children).toHaveLength(2);
		expect(root?.children[0]?.classList.contains("preview__sidebar")).toBe(true);
		expect(root?.children[1]?.classList.contains("preview__main")).toBe(true);
		expect(container.querySelector(".preview__body > .preview__inspector")).not.toBeNull();
		await unmount();
	});
});
