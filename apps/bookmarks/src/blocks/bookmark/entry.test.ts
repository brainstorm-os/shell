// @vitest-environment jsdom
import type { BlockRuntimeContext } from "@brainstorm-os/sdk/block-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootBookmark } from "./entry";

const BOOKMARK_TYPE = "brainstorm/Bookmark/v1";

function makeCtx(bookmark: unknown): {
	root: HTMLElement;
	navigate: ReturnType<typeof vi.fn>;
	run(): Promise<void>;
} {
	const root = document.createElement("div");
	document.body.appendChild(root);
	const navigate = vi.fn();
	let loader: (() => void | Promise<void>) | null = null;
	const ctx = {
		entityId: "bm-1",
		capabilities: () => [],
		root,
		graph: (async (messageName: string) =>
			messageName === "getEntity" ? bookmark : null) as unknown as <T>(
			m: string,
			d: unknown,
		) => Promise<T>,
		navigate,
		reportHeight: vi.fn(),
		onLoad: (run: () => void | Promise<void>) => {
			loader = run;
		},
	} satisfies BlockRuntimeContext;
	bootBookmark(ctx);
	return { root, navigate, run: async () => loader?.() };
}

afterEach(() => {
	document.body.replaceChildren();
});

describe("bookmark block", () => {
	it("renders title and host", async () => {
		const h = makeCtx({
			entityId: "bm-1",
			entityTypeId: BOOKMARK_TYPE,
			properties: { title: "Design Systems", url: "https://www.example.com/design" },
			updatedAt: 1,
		});
		await h.run();
		expect(h.root.querySelector(".bsbm__title")?.textContent).toBe("Design Systems");
		expect(h.root.querySelector(".bsbm__meta")?.textContent).toBe("example.com");
	});

	it("falls back to the host as the title when none is set", async () => {
		const h = makeCtx({
			entityId: "bm-1",
			entityTypeId: BOOKMARK_TYPE,
			properties: { title: "", url: "https://news.example.org/article" },
			updatedAt: 1,
		});
		await h.run();
		expect(h.root.querySelector(".bsbm__title")?.textContent).toBe("news.example.org");
	});

	it("renders a monogram when there is no data-URI favicon", async () => {
		const h = makeCtx({
			entityId: "bm-1",
			entityTypeId: BOOKMARK_TYPE,
			properties: {
				title: "Anytype",
				url: "https://anytype.io",
				faviconUrl: "https://anytype.io/favicon.ico",
			},
			updatedAt: 1,
		});
		await h.run();
		// A remote favicon can't load under `img-src data:` — drop it for the monogram.
		expect(h.root.querySelector(".bsbm__icon img")).toBeNull();
		expect(h.root.querySelector(".bsbm__icon")?.textContent).toBe("A");
	});

	it("renders a data-URI favicon as an <img>", async () => {
		const dataUri = "data:image/png;base64,iVBORw0KGgo=";
		const h = makeCtx({
			entityId: "bm-1",
			entityTypeId: BOOKMARK_TYPE,
			properties: { title: "Local", url: "https://x.test", faviconUrl: dataUri },
			updatedAt: 1,
		});
		await h.run();
		expect(h.root.querySelector<HTMLImageElement>(".bsbm__icon img")?.src).toBe(dataUri);
	});

	it("clicking the card navigates to the bookmark", async () => {
		const h = makeCtx({
			entityId: "bm-1",
			entityTypeId: BOOKMARK_TYPE,
			properties: { title: "Design Systems", url: "https://example.com" },
			updatedAt: 1,
		});
		await h.run();
		h.root.click();
		expect(h.navigate).toHaveBeenCalledWith("bm-1", BOOKMARK_TYPE);
	});

	it("shows an error on load failure", async () => {
		const root = document.createElement("div");
		document.body.appendChild(root);
		const held: { loader: (() => void | Promise<void>) | null } = { loader: null };
		const ctx = {
			entityId: "bm-1",
			capabilities: () => [],
			root,
			graph: (async () => null) as unknown as <T>(m: string, d: unknown) => Promise<T>,
			navigate: vi.fn(),
			reportHeight: vi.fn(),
			onLoad: (run: () => void | Promise<void>) => {
				held.loader = run;
			},
		} satisfies BlockRuntimeContext;
		bootBookmark(ctx);
		await held.loader?.();
		expect(root.querySelector(".bsbm__error")).not.toBeNull();
	});
});
