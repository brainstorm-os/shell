// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SAMPLE_BOOK_CONTENT } from "../logic/sample-book";
import { ReadingFamily, ReadingTheme } from "../logic/typography";
import { HighlightColor } from "../types/highlight";
import { type ReaderHandle, mountReader } from "./reader";

class StubResizeObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

let handle: ReaderHandle | null = null;

/** jsdom reports every box as 0x0, so the reader always took its
 *  no-geometry fallback and the MEASURED pagination path never ran under
 *  test. Faking a laid-out page is what exercises it. */
function withLayoutBoxes(width: number, height: number): () => void {
	// jsdom defines these on Element, not HTMLElement — patching the wrong
	// prototype leaves nothing to restore and leaks the stub into every
	// following test.
	const proto = Element.prototype;
	const w = Object.getOwnPropertyDescriptor(proto, "clientWidth");
	const h = Object.getOwnPropertyDescriptor(proto, "clientHeight");
	Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => width });
	Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => height });
	return () => {
		if (w) Object.defineProperty(proto, "clientWidth", w);
		else Reflect.deleteProperty(proto, "clientWidth");
		if (h) Object.defineProperty(proto, "clientHeight", h);
		else Reflect.deleteProperty(proto, "clientHeight");
	};
}

function scaffold(): { root: HTMLElement; right: HTMLElement } {
	document.body.innerHTML = `
		<header class="app-header">
			<div class="app-header__left"></div>
			<div class="app-header__right"></div>
		</header>
		<main class="books" id="books-root"></main>
	`;
	const root = document.querySelector<HTMLElement>("#books-root");
	const right = document.querySelector<HTMLElement>(".app-header__right");
	if (!root || !right) throw new Error("scaffold failed");
	return { root, right };
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

describe("reader render with a measured page box", () => {
	// The measured path is only reachable once the page reports a real box.
	// Its first run happens during mount, inside `createReaderState` — so a
	// binding it closes over that is declared further down the function body
	// throws a TDZ ReferenceError in a real browser while every jsdom test
	// stays green on the fallback. That is exactly how it shipped once.
	it("mounts and paginates without touching an uninitialised binding", () => {
		const restore = withLayoutBoxes(700, 600);
		try {
			const { root, right } = scaffold();
			handle = mountReader(root, right, SAMPLE_BOOK_CONTENT);
			expect(root.querySelector(".books__page")).not.toBeNull();
			expect(root.querySelector(".books__status")?.textContent).toMatch(/\d+/);
		} finally {
			restore();
		}
	});

	it("leaves no ruler behind after measuring", () => {
		const restore = withLayoutBoxes(700, 600);
		try {
			const { root, right } = scaffold();
			handle = mountReader(root, right, SAMPLE_BOOK_CONTENT);
			expect(root.querySelector(".books__ruler")).toBeNull();
		} finally {
			restore();
		}
	});

	it("turns the page on a wheel gesture past the threshold", () => {
		const restore = withLayoutBoxes(700, 600);
		try {
			const { root, right } = scaffold();
			handle = mountReader(root, right, SAMPLE_BOOK_CONTENT);
			const stage = root.querySelector(".books__stage");
			if (!stage) throw new Error("no stage");
			const before = root.querySelector(".books__status")?.textContent;
			stage.dispatchEvent(new WheelEvent("wheel", { deltaY: 400, bubbles: true }));
			expect(root.querySelector(".books__status")?.textContent).not.toBe(before);
		} finally {
			restore();
		}
	});
});

describe("reader render", () => {
	it("paints the typography controls + the first page content + page status", () => {
		const { root, right } = scaffold();
		handle = mountReader(root, right, SAMPLE_BOOK_CONTENT);
		expect(right.querySelector(".books__type-btn")).not.toBeNull();
		expect(right.querySelector(".books__hl-btn")).not.toBeNull();
		expect(root.querySelector(".books__page")?.textContent).toContain("The Reflow");
		expect(root.querySelector(".books__status")?.textContent).toMatch(/Page 1 of \d+/);
	});

	it("disables prev on the first page and advances on next", () => {
		const { root, right } = scaffold();
		handle = mountReader(root, right, SAMPLE_BOOK_CONTENT);
		const prev = root.querySelector<HTMLButtonElement>(".books__nav-btn");
		const buttons = root.querySelectorAll<HTMLButtonElement>(".books__nav-btn");
		const next = buttons[buttons.length - 1];
		expect(prev?.disabled).toBe(true);
		const before = root.querySelector(".books__status")?.textContent;
		next?.click();
		const after = root.querySelector(".books__status")?.textContent;
		expect(after).not.toBe(before);
		expect(prev?.disabled).toBe(false);
	});

	it("ArrowRight advances the page via the shortcut binding", () => {
		const { root, right } = scaffold();
		handle = mountReader(root, right, SAMPLE_BOOK_CONTENT);
		const before = root.querySelector(".books__status")?.textContent;
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
		expect(root.querySelector(".books__status")?.textContent).not.toBe(before);
	});

	it("applies the default reader vars + the match-app theme class", () => {
		const { root, right } = scaffold();
		handle = mountReader(root, right, SAMPLE_BOOK_CONTENT);
		expect(root.style.getPropertyValue("--reader-measure")).toBe("65ch");
		expect(root.style.getPropertyValue("--reader-leading")).toBe("1.6");
		expect(root.classList.contains("books--theme-theme")).toBe(true);
	});

	it("dispose removes the keyboard binding", () => {
		const { root, right } = scaffold();
		handle = mountReader(root, right, SAMPLE_BOOK_CONTENT);
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
		const advanced = root.querySelector(".books__status")?.textContent;
		handle.dispose();
		handle = null;
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
		expect(root.querySelector(".books__status")?.textContent).toBe(advanced);
	});
});

describe("typography controls", () => {
	function openPanel(right: HTMLElement): HTMLElement {
		const typeBtn = right.querySelector<HTMLButtonElement>(".books__type-btn");
		typeBtn?.click();
		const panel = document.querySelector<HTMLElement>("[data-testid='books-typography-panel']");
		if (!panel) throw new Error("typography panel did not open");
		return panel;
	}

	it("opens a typography panel from the header Aa control", () => {
		const { root, right } = scaffold();
		handle = mountReader(root, right, SAMPLE_BOOK_CONTENT);
		const typeBtn = right.querySelector<HTMLButtonElement>(".books__type-btn");
		expect(typeBtn?.textContent).toBe("Aa");
		openPanel(right);
		expect(typeBtn?.getAttribute("aria-expanded")).toBe("true");
		expect(document.querySelectorAll(".books__type-row").length).toBe(5);
	});

	it("changing the size axis applies the var and reports the change", () => {
		const onTypographyChange = vi.fn();
		const { root, right } = scaffold();
		handle = mountReader(root, right, SAMPLE_BOOK_CONTENT, { onTypographyChange });
		const panel = openPanel(right);
		const sizeStep = panel.querySelectorAll<HTMLButtonElement>(".books__type-step");
		const sizeUp = sizeStep[1];
		sizeUp?.click();
		expect(handle.typography().size).toBe(20);
		expect(root.style.getPropertyValue("--reader-font-size")).toBe("20px");
		expect(onTypographyChange).toHaveBeenCalled();
		const [serialized, settings] = onTypographyChange.mock.calls.at(-1) ?? [];
		expect(JSON.parse(serialized).size).toBe(20);
		expect(settings.size).toBe(20);
	});

	it("picking a reading theme swaps the page theme class", () => {
		const { root, right } = scaffold();
		handle = mountReader(root, right, SAMPLE_BOOK_CONTENT);
		const panel = openPanel(right);
		const sepia = panel.querySelector<HTMLButtonElement>(".books__type-swatch--sepia");
		sepia?.click();
		expect(root.classList.contains("books--theme-sepia")).toBe(true);
		expect(root.classList.contains("books--theme-theme")).toBe(false);
	});

	it("seeds from initialTypography", () => {
		const { root, right } = scaffold();
		handle = mountReader(root, right, SAMPLE_BOOK_CONTENT, {
			initialTypography: {
				family: ReadingFamily.Serif,
				size: 24,
				leading: 1.8,
				measure: 80,
				theme: ReadingTheme.Dark,
			},
		});
		expect(root.style.getPropertyValue("--reader-font-size")).toBe("24px");
		expect(root.classList.contains("books--theme-dark")).toBe(true);
	});

	it("dispose closes an open typography panel", () => {
		const { root, right } = scaffold();
		handle = mountReader(root, right, SAMPLE_BOOK_CONTENT);
		openPanel(right);
		handle.dispose();
		handle = null;
		expect(document.querySelector("[data-testid='books-typography-panel']")).toBeNull();
	});
});

describe("reading-position persistence", () => {
	it("reports the new locator + progress on navigation", () => {
		const onPositionChange = vi.fn();
		const { root, right } = scaffold();
		handle = mountReader(root, right, SAMPLE_BOOK_CONTENT, { onPositionChange });
		const buttons = root.querySelectorAll<HTMLButtonElement>(".books__nav-btn");
		buttons[buttons.length - 1]?.click();
		expect(onPositionChange).toHaveBeenCalledTimes(1);
		const [locator, progress] = onPositionChange.mock.calls.at(-1) ?? [];
		expect(locator).toEqual(handle.position());
		expect(progress).toBeGreaterThan(0);
	});

	it("restores to the page holding initialPosition on mount", () => {
		const probe = scaffold();
		const reader = mountReader(probe.root, probe.right, SAMPLE_BOOK_CONTENT);
		const buttons = probe.root.querySelectorAll<HTMLButtonElement>(".books__nav-btn");
		const next = buttons[buttons.length - 1];
		next?.click();
		next?.click();
		const parked = reader.position();
		reader.dispose();
		if (!parked) throw new Error("expected a parked locator after navigating");

		const { root, right } = scaffold();
		handle = mountReader(root, right, SAMPLE_BOOK_CONTENT, { initialPosition: parked });
		expect(handle.position()).toEqual(parked);
		expect(root.querySelector(".books__status")?.textContent).not.toMatch(/Page 1 of/);
	});

	it("does not report on mount (no spurious initial write)", () => {
		const onPositionChange = vi.fn();
		const { root, right } = scaffold();
		handle = mountReader(root, right, SAMPLE_BOOK_CONTENT, {
			initialPosition: { spineIndex: 0, charOffset: 0 },
			onPositionChange,
		});
		expect(onPositionChange).not.toHaveBeenCalled();
	});
});

describe("highlight authoring", () => {
	function addHighlight(h: ReaderHandle, color = HighlightColor.Yellow): void {
		// The heading "The Reflow" is 10 chars; the next paragraph ("A book…")
		// starts at offset 10, so [10, 16) covers "A book".
		h.highlights().add({
			id: "hl-test",
			bookId: "sample-book",
			anchor: { start: { spineIndex: 0, charOffset: 10 }, end: { spineIndex: 0, charOffset: 16 } },
			color,
			quote: "A book",
			note: "",
			createdAt: 0,
			updatedAt: 0,
		});
	}

	it("paints an added highlight as a coloured mark on the page", () => {
		const { root, right } = scaffold();
		handle = mountReader(root, right, SAMPLE_BOOK_CONTENT);
		addHighlight(handle, HighlightColor.Green);
		const mark = root.querySelector("mark.books__mark--green");
		expect(mark).not.toBeNull();
		expect(mark?.textContent).toBe("A book");
	});

	it("opens the highlights panel from the header control and lists the highlight", () => {
		const { root, right } = scaffold();
		handle = mountReader(root, right, SAMPLE_BOOK_CONTENT);
		addHighlight(handle);
		right.querySelector<HTMLButtonElement>(".books__hl-btn")?.click();
		const panel = document.querySelector<HTMLElement>("[data-testid='books-highlights-panel']");
		expect(panel).not.toBeNull();
		expect(panel?.querySelector(".books__hl-quote")?.textContent).toBe("A book");
		expect(panel?.querySelector(".books__hl-count")?.textContent).toContain("1");
	});

	it("the panel refreshes live when a highlight is removed", () => {
		const { root, right } = scaffold();
		handle = mountReader(root, right, SAMPLE_BOOK_CONTENT);
		addHighlight(handle);
		right.querySelector<HTMLButtonElement>(".books__hl-btn")?.click();
		document
			.querySelector<HTMLElement>("[data-testid='books-highlights-panel'] .books__hl-remove")
			?.click();
		const panel = document.querySelector<HTMLElement>("[data-testid='books-highlights-panel']");
		expect(panel?.querySelector(".books__hl-empty")).not.toBeNull();
		expect(root.querySelector("mark.books__mark")).toBeNull();
	});

	function selectOnPage(root: HTMLElement): { removeAllRanges: ReturnType<typeof vi.fn> } {
		// Select "A book" — the first 6 chars of the paragraph fragment that
		// follows the page-1 heading (spine offset 10).
		const para = root.querySelectorAll(".books__page > *")[1];
		const textNode = para?.firstChild;
		if (!textNode) throw new Error("page paragraph missing");
		const removeAllRanges = vi.fn();
		const fake = {
			rangeCount: 1,
			isCollapsed: false,
			anchorNode: textNode,
			anchorOffset: 0,
			focusNode: textNode,
			focusOffset: 6,
			removeAllRanges,
		} as unknown as Selection;
		vi.spyOn(window, "getSelection").mockReturnValue(fake);
		return { removeAllRanges };
	}

	async function releaseSelection(root: HTMLElement): Promise<void> {
		root.querySelector(".books__page")?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 0));
	}

	it("selecting a passage opens a create dialog with the quote preview, swatches and actions", async () => {
		const { root, right } = scaffold();
		handle = mountReader(root, right, SAMPLE_BOOK_CONTENT);
		selectOnPage(root);
		await releaseSelection(root);
		const dialog = document.querySelector<HTMLElement>("[data-testid='books-selection-menu']");
		expect(dialog).not.toBeNull();
		expect(dialog?.querySelector(".books__hl-preview")?.textContent).toBe("A book");
		expect(dialog?.querySelectorAll(".books__hl-swatch").length).toBe(5);
		expect(dialog?.querySelector(".books__hl-confirm")).not.toBeNull();
		expect(dialog?.querySelector(".books__hl-cancel")).not.toBeNull();
	});

	it("confirming the dialog stores the highlight, paints it and lists it in the panel", async () => {
		const { root, right } = scaffold();
		handle = mountReader(root, right, SAMPLE_BOOK_CONTENT, { newHighlightId: () => "hl-1" });
		const { removeAllRanges } = selectOnPage(root);
		await releaseSelection(root);
		const dialog = document.querySelector<HTMLElement>("[data-testid='books-selection-menu']");
		dialog?.querySelector<HTMLButtonElement>(".books__hl-swatch--green")?.click();
		dialog?.querySelector<HTMLButtonElement>(".books__hl-confirm")?.click();
		expect(document.querySelector("[data-testid='books-selection-menu']")).toBeNull();
		expect(removeAllRanges).toHaveBeenCalled();
		const stored = handle.highlights().list();
		expect(stored).toHaveLength(1);
		expect(stored[0]?.quote).toBe("A book");
		expect(stored[0]?.color).toBe(HighlightColor.Green);
		const mark = root.querySelector("mark.books__mark--green");
		expect(mark?.textContent).toBe("A book");
		vi.restoreAllMocks();
		right.querySelector<HTMLButtonElement>(".books__hl-btn")?.click();
		const panel = document.querySelector<HTMLElement>("[data-testid='books-highlights-panel']");
		expect(panel?.querySelector(".books__hl-quote")?.textContent).toBe("A book");
	});

	it("cancelling the dialog stores nothing", async () => {
		const { root, right } = scaffold();
		handle = mountReader(root, right, SAMPLE_BOOK_CONTENT);
		selectOnPage(root);
		await releaseSelection(root);
		const dialog = document.querySelector<HTMLElement>("[data-testid='books-selection-menu']");
		dialog?.querySelector<HTMLButtonElement>(".books__hl-cancel")?.click();
		expect(document.querySelector("[data-testid='books-selection-menu']")).toBeNull();
		expect(handle.highlights().list()).toHaveLength(0);
	});

	it("forwards highlight writes to the persistence port", () => {
		const create = vi.fn();
		const { root, right } = scaffold();
		handle = mountReader(root, right, SAMPLE_BOOK_CONTENT, {
			highlightPort: { create },
		});
		addHighlight(handle);
		expect(create).toHaveBeenCalledTimes(1);
	});

	it("the header highlights control renders a highlighter glyph, not a text pilcrow", () => {
		const { root, right } = scaffold();
		handle = mountReader(root, right, SAMPLE_BOOK_CONTENT);
		const btn = right.querySelector<HTMLButtonElement>(".books__hl-btn");
		expect(btn?.querySelector("svg")).not.toBeNull();
		expect(btn?.textContent).toBe("");
	});

	it("dispose closes an open highlights panel", () => {
		const { root, right } = scaffold();
		handle = mountReader(root, right, SAMPLE_BOOK_CONTENT);
		addHighlight(handle);
		right.querySelector<HTMLButtonElement>(".books__hl-btn")?.click();
		expect(document.querySelector("[data-testid='books-highlights-panel']")).not.toBeNull();
		handle.dispose();
		handle = null;
		expect(document.querySelector("[data-testid='books-highlights-panel']")).toBeNull();
	});
});
