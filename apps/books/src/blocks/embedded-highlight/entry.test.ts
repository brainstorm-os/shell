// @vitest-environment jsdom
import type { BlockRuntimeContext } from "@brainstorm-os/sdk/block-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootEmbeddedHighlight } from "./entry";

const HIGHLIGHT_TYPE = "brainstorm/Highlight/v1";
const BOOK_TYPE = "brainstorm/Book/v1";

function makeCtx(
	highlight: unknown,
	book: unknown = null,
): {
	root: HTMLElement;
	navigate: ReturnType<typeof vi.fn>;
	reportHeight: ReturnType<typeof vi.fn>;
	getEntity: ReturnType<typeof vi.fn>;
	run(): Promise<void>;
} {
	const root = document.createElement("div");
	document.body.appendChild(root);
	const navigate = vi.fn();
	const reportHeight = vi.fn();
	let loader: (() => void | Promise<void>) | null = null;
	const getEntity = vi.fn(async (_msg: string, data: { entityId: string }) => {
		if (data.entityId === "hl-1") return highlight;
		if (data.entityId === "bk-1") return book;
		return null;
	});
	const ctx = {
		entityId: "hl-1",
		capabilities: () => [],
		root,
		graph: ((m: string, d: unknown) => getEntity(m, d as { entityId: string })) as unknown as <T>(
			m: string,
			d: unknown,
		) => Promise<T>,
		navigate,
		reportHeight,
		onLoad: (run: () => void | Promise<void>) => {
			loader = run;
		},
	} satisfies BlockRuntimeContext;
	bootEmbeddedHighlight(ctx);
	return { root, navigate, reportHeight, getEntity, run: async () => loader?.() };
}

function highlight(props: Record<string, unknown>): unknown {
	return { entityId: "hl-1", entityTypeId: HIGHLIGHT_TYPE, properties: props, updatedAt: 1 };
}

function book(props: Record<string, unknown>): unknown {
	return { entityId: "bk-1", entityTypeId: BOOK_TYPE, properties: props, updatedAt: 1 };
}

afterEach(() => {
	document.body.replaceChildren();
});

describe("embedded-highlight block", () => {
	it("renders the quote, colour swatch, and resolved book title", async () => {
		const h = makeCtx(
			highlight({ bookId: "bk-1", color: "green", quote: "The unexamined life", note: "" }),
			book({ name: "Apology" }),
		);
		await h.run();
		expect(h.root.querySelector(".bshl__quote")?.textContent).toBe("The unexamined life");
		expect(h.root.querySelector(".bshl__meta")?.textContent).toBe("Apology");
		const swatch = h.root.querySelector(".bshl__swatch") as HTMLElement | null;
		expect(swatch?.style.background).toBe("rgb(52, 211, 153)");
	});

	it("renders the attached note when present, omits it when empty", async () => {
		const withNote = makeCtx(
			highlight({ bookId: "bk-1", color: "blue", quote: "Q", note: "my thought" }),
			book({ name: "Book" }),
		);
		await withNote.run();
		expect(withNote.root.querySelector(".bshl__note")?.textContent).toBe("my thought");

		const noNote = makeCtx(
			highlight({ bookId: "bk-1", color: "blue", quote: "Q", note: "" }),
			book({ name: "Book" }),
		);
		await noNote.run();
		expect(noNote.root.querySelector(".bshl__note")).toBeNull();
	});

	it("falls back when quote / book / colour are missing", async () => {
		const h = makeCtx(highlight({ bookId: "", color: "", quote: "" }), null);
		await h.run();
		expect(h.root.querySelector(".bshl__quote")?.textContent).toBe("Untitled highlight");
		expect(h.root.querySelector(".bshl__meta")?.textContent).toBe("Unknown book");
		const swatch = h.root.querySelector(".bshl__swatch") as HTMLElement | null;
		// Unknown colour falls back to the yellow swatch.
		expect(swatch?.style.background).toBe("rgb(250, 204, 21)");
	});

	it("shows 'Unknown book' when the book can't be resolved but the quote still renders", async () => {
		const h = makeCtx(highlight({ bookId: "missing", color: "pink", quote: "Lone quote" }), null);
		await h.run();
		expect(h.root.querySelector(".bshl__quote")?.textContent).toBe("Lone quote");
		expect(h.root.querySelector(".bshl__meta")?.textContent).toBe("Unknown book");
	});

	it("clicking the card navigates to the source book", async () => {
		const h = makeCtx(
			highlight({ bookId: "bk-1", color: "yellow", quote: "Q" }),
			book({ name: "Book" }),
		);
		await h.run();
		h.root.click();
		expect(h.navigate).toHaveBeenCalledWith("bk-1", BOOK_TYPE);
	});

	it("does not navigate when the highlight has no bookId", async () => {
		const h = makeCtx(highlight({ bookId: "", color: "yellow", quote: "Q" }), null);
		await h.run();
		h.root.click();
		expect(h.navigate).not.toHaveBeenCalled();
	});

	it("reports its content height after rendering", async () => {
		const h = makeCtx(highlight({ bookId: "bk-1", color: "yellow", quote: "Q" }), book({}));
		await h.run();
		expect(h.reportHeight).toHaveBeenCalled();
	});

	it("shows an error card when the highlight can't be loaded", async () => {
		const h = makeCtx(null);
		await h.run();
		expect(h.root.querySelector(".bshl__error")).not.toBeNull();
		expect(h.navigate).not.toHaveBeenCalled();
		expect(h.reportHeight).toHaveBeenCalled();
	});
});
