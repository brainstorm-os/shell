// @vitest-environment jsdom
import type { PdfLink } from "@brainstorm-os/sdk/pdf-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfTint } from "../logic/pdf-view";
import { makeLocator } from "../types/locator";
import { type PdfPagePort, type PdfReaderHandle, mountPdfReader } from "./pdf-reader";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

class StubResizeObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

let handle: PdfReaderHandle | null = null;

function scaffold(): { root: HTMLElement; controls: HTMLElement } {
	document.body.innerHTML = `
		<header class="app-header">
			<div class="app-header__left"></div>
			<div class="app-header__right"><span class="books__reader-controls"></span></div>
		</header>
		<main class="books" id="books-root"></main>
	`;
	const root = document.querySelector<HTMLElement>("#books-root");
	const controls = document.querySelector<HTMLElement>(".books__reader-controls");
	if (!root || !controls) throw new Error("scaffold failed");
	return { root, controls };
}

type PortTracker = {
	rendered: number[];
	cancels: number;
	disposeCalls: number;
};

function fakePort(pageCount: number): { port: PdfPagePort } & { tracker: PortTracker } {
	const tracker: PortTracker = {
		rendered: [],
		cancels: 0,
		disposeCalls: 0,
	};
	const port: PdfPagePort = {
		pageCount,
		renderPage(pageIndex) {
			tracker.rendered.push(pageIndex);
			return {
				promise: Promise.resolve(),
				cancel: () => {
					tracker.cancels += 1;
				},
			};
		},
		dispose: () => {
			tracker.disposeCalls += 1;
		},
	};
	return { port, tracker };
}

beforeEach(() => {
	vi.stubGlobal("ResizeObserver", StubResizeObserver);
});

afterEach(() => {
	handle?.dispose();
	handle = null;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("pdf reader render", () => {
	it("paints the first page, the aria title, and the status line", () => {
		const { root, controls } = scaffold();
		const fake = fakePort(12);
		handle = mountPdfReader(root, controls, "Deep Work", fake.port);
		expect(root.querySelector(".books__pdf-canvas")?.getAttribute("aria-label")).toContain(
			"Deep Work",
		);
		expect(root.querySelector(".books__pdf-canvas")).not.toBeNull();
		expect(root.querySelector(".books__status")?.textContent).toBe("Page 1 of 12");
		expect(root.querySelector(".books__progress")?.textContent).toBe("8% read");
		expect(fake.tracker.rendered).toEqual([0]);
	});

	it("restores the parked reading position on mount", () => {
		const { root, controls } = scaffold();
		const fake = fakePort(12);
		handle = mountPdfReader(root, controls, "Deep Work", fake.port, {
			initialPosition: makeLocator(4, 0),
		});
		expect(root.querySelector(".books__status")?.textContent).toBe("Page 5 of 12");
		expect(fake.tracker.rendered).toEqual([4]);
		expect(handle.position()).toEqual(makeLocator(4, 0));
	});

	it("shows the empty state (no canvas) for a zero-page document", () => {
		const { root, controls } = scaffold();
		handle = mountPdfReader(root, controls, "Empty", fakePort(0).port);
		expect(root.querySelector(".books__pdf-canvas")).toBeNull();
		expect(root.querySelector(".books__empty")).not.toBeNull();
		expect(handle.position()).toBeNull();
	});
});

describe("pdf reader navigation", () => {
	it("next advances, fires the persistence seam, and cancels the in-flight render", () => {
		const { root, controls } = scaffold();
		const fake = fakePort(3);
		const onPositionChange = vi.fn();
		handle = mountPdfReader(root, controls, "B", fake.port, { onPositionChange });
		const buttons = root.querySelectorAll<HTMLButtonElement>(".books__nav-btn");
		const prev = buttons[0];
		const next = buttons[buttons.length - 1];
		expect(prev?.disabled).toBe(true);
		next?.click();
		expect(root.querySelector(".books__status")?.textContent).toBe("Page 2 of 3");
		expect(fake.tracker.rendered).toEqual([0, 1]);
		expect(fake.tracker.cancels).toBe(1);
		expect(onPositionChange).toHaveBeenCalledWith(makeLocator(1, 0), 2 / 3);
		expect(prev?.disabled).toBe(false);
	});

	it("does not fire the seam on an edge no-op", () => {
		const { root, controls } = scaffold();
		const onPositionChange = vi.fn();
		handle = mountPdfReader(root, controls, "B", fakePort(2).port, { onPositionChange });
		const prev = root.querySelector<HTMLButtonElement>(".books__nav-btn");
		prev?.click();
		expect(onPositionChange).not.toHaveBeenCalled();
	});

	it("ArrowRight / ArrowLeft page via the shortcut binding", () => {
		const { root, controls } = scaffold();
		const fake = fakePort(5);
		handle = mountPdfReader(root, controls, "B", fake.port);
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
		expect(root.querySelector(".books__status")?.textContent).toBe("Page 2 of 5");
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
		expect(root.querySelector(".books__status")?.textContent).toBe("Page 1 of 5");
	});
});

describe("pdf reader links", () => {
	function linkPort(pageCount: number, linksByPage: Record<number, PdfLink[]>): PdfPagePort {
		return {
			pageCount,
			renderPage: () => ({ promise: Promise.resolve(), cancel: () => {} }),
			getPageLinks: (pageIndex) => Promise.resolve(linksByPage[pageIndex] ?? []),
			dispose: () => {},
		};
	}

	it("renders a link hotspot over the page and opens it on click", async () => {
		const { root, controls } = scaffold();
		const onOpenLink = vi.fn();
		const link: PdfLink = {
			url: "https://example.com",
			rect: { left: 12, top: 24, width: 80, height: 16 },
		};
		handle = mountPdfReader(root, controls, "B", linkPort(3, { 0: [link] }), { onOpenLink });
		await tick();
		const anchor = root.querySelector<HTMLAnchorElement>(".books__pdf-link");
		expect(anchor).not.toBeNull();
		expect(anchor?.style.left).toBe("12px");
		expect(anchor?.style.width).toBe("80px");
		expect(anchor?.getAttribute("rel")).toBe("noopener noreferrer");
		anchor?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		expect(onOpenLink).toHaveBeenCalledWith("https://example.com");
	});

	it("clears stale link hotspots when paging to a page without links", async () => {
		const { root, controls } = scaffold();
		const link: PdfLink = { url: "https://a.com", rect: { left: 0, top: 0, width: 10, height: 10 } };
		handle = mountPdfReader(root, controls, "B", linkPort(3, { 0: [link] }));
		await tick();
		expect(root.querySelector(".books__pdf-link")).not.toBeNull();
		const next = root.querySelectorAll<HTMLButtonElement>(".books__nav-btn");
		next[next.length - 1]?.click();
		await tick();
		expect(root.querySelector(".books__pdf-link")).toBeNull();
	});
});

describe("pdf reader view controls", () => {
	type SizedPort = { port: PdfPagePort; widths: number[] };
	function sizedPort(pageCount: number): SizedPort {
		const widths: number[] = [];
		return {
			widths,
			port: {
				pageCount,
				renderPage: (_pageIndex, _canvas, maxWidth) => {
					widths.push(maxWidth);
					return { promise: Promise.resolve(), cancel: () => {} };
				},
				dispose: () => {},
			},
		};
	}

	function openPanel(controls: HTMLElement): HTMLElement {
		controls.querySelector<HTMLButtonElement>(".books__view-btn")?.click();
		const panel = document.querySelector<HTMLElement>("[data-testid='books-pdf-view-panel']");
		if (!panel) throw new Error("view panel did not open");
		return panel;
	}

	it("mounts a View control into the header and opens the zoom + tint panel", () => {
		const { root, controls } = scaffold();
		handle = mountPdfReader(root, controls, "B", fakePort(5).port);
		const viewBtn = controls.querySelector<HTMLButtonElement>(".books__view-btn");
		expect(viewBtn).not.toBeNull();
		const panel = openPanel(controls);
		expect(viewBtn?.getAttribute("aria-expanded")).toBe("true");
		expect(panel.querySelector("[data-testid='books-pdf-zoom']")?.textContent).toBe("100%");
		expect(panel.querySelectorAll(".books__type-swatch").length).toBe(3);
	});

	it("zooming in enlarges the render box, marks the surface scrollable, and reports it", () => {
		const { root, controls } = scaffold();
		const sized = sizedPort(5);
		const onViewChange = vi.fn();
		handle = mountPdfReader(root, controls, "B", sized.port, { onViewChange });
		const baseWidth = sized.widths.at(-1) ?? 0;
		const panel = openPanel(controls);
		const zoomIn = panel.querySelectorAll<HTMLButtonElement>(".books__type-step")[1];
		zoomIn?.click();
		expect(panel.querySelector("[data-testid='books-pdf-zoom']")?.textContent).toBe("110%");
		expect(sized.widths.at(-1)).toBeGreaterThan(baseWidth);
		expect(root.classList.contains("books--pdf-zoomed")).toBe(true);
		expect(onViewChange).toHaveBeenCalledWith(expect.objectContaining({ zoom: 110 }));
	});

	it("picking a tint toggles the canvas-filter class on the surface", () => {
		const { root, controls } = scaffold();
		handle = mountPdfReader(root, controls, "B", fakePort(5).port);
		const panel = openPanel(controls);
		panel.querySelector<HTMLButtonElement>(".books__type-swatch--dark")?.click();
		expect(root.classList.contains("books--pdf-tint-dark")).toBe(true);
		expect(root.classList.contains("books--pdf-tint-light")).toBe(false);
	});

	it("seeds from initialView", () => {
		const { root, controls } = scaffold();
		handle = mountPdfReader(root, controls, "B", fakePort(5).port, {
			initialView: { zoom: 150, tint: PdfTint.Sepia },
		});
		expect(root.classList.contains("books--pdf-tint-sepia")).toBe(true);
		expect(root.classList.contains("books--pdf-zoomed")).toBe(true);
		const panel = openPanel(controls);
		expect(panel.querySelector("[data-testid='books-pdf-zoom']")?.textContent).toBe("150%");
	});
});

describe("pdf reader lifecycle", () => {
	it("dispose tears the port down, unbinds the chords, and clears the header controls", () => {
		const { root, controls } = scaffold();
		const fake = fakePort(5);
		handle = mountPdfReader(root, controls, "B", fake.port, {
			initialView: { zoom: 150, tint: PdfTint.Dark },
		});
		expect(controls.querySelector(".books__view-btn")).not.toBeNull();
		handle.dispose();
		handle = null;
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
		expect(root.querySelector(".books__status")?.textContent).toBe("Page 1 of 5");
		expect(fake.tracker.disposeCalls).toBe(1);
		expect(fake.tracker.rendered).toEqual([0]);
		expect(controls.querySelector(".books__view-btn")).toBeNull();
		expect(root.classList.contains("books--pdf-tint-dark")).toBe(false);
		expect(root.classList.contains("books--pdf-zoomed")).toBe(false);
	});
});
