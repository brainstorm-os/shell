// @vitest-environment jsdom
import type { BlockRuntimeContext } from "@brainstorm-os/sdk/block-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootEmbeddedWhiteboard } from "./entry";

const WHITEBOARD_TYPE = "brainstorm/Whiteboard/v1";

function makeCtx(board: unknown): {
	root: HTMLElement;
	navigate: ReturnType<typeof vi.fn>;
	reportHeight: ReturnType<typeof vi.fn>;
	run(): Promise<void>;
} {
	const root = document.createElement("div");
	document.body.appendChild(root);
	const navigate = vi.fn();
	const reportHeight = vi.fn();
	let loader: (() => void | Promise<void>) | null = null;
	const ctx = {
		entityId: "wb-1",
		capabilities: () => [],
		root,
		graph: (async (messageName: string) =>
			messageName === "getEntity" ? board : null) as unknown as <T>(
			m: string,
			d: unknown,
		) => Promise<T>,
		navigate,
		reportHeight,
		onLoad: (run: () => void | Promise<void>) => {
			loader = run;
		},
	} satisfies BlockRuntimeContext;
	bootEmbeddedWhiteboard(ctx);
	return { root, navigate, reportHeight, run: async () => loader?.() };
}

function board(props: Record<string, unknown>): unknown {
	return { entityId: "wb-1", entityTypeId: WHITEBOARD_TYPE, properties: props, updatedAt: 1 };
}

afterEach(() => {
	document.body.replaceChildren();
});

describe("embedded-whiteboard block", () => {
	it("renders the board name and an item-count summary", async () => {
		const h = makeCtx(
			board({
				name: "Roadmap",
				nodes: [{ kind: "sticky" }, { kind: "text" }, { kind: "image" }],
			}),
		);
		await h.run();
		expect(h.root.querySelector(".bswb__title")?.textContent).toBe("Roadmap");
		expect(h.root.querySelector(".bswb__meta")?.textContent).toBe("3 items");
	});

	it("counts frames separately from items and pluralises", async () => {
		const h = makeCtx(
			board({
				name: "Org",
				nodes: [{ kind: "frame" }, { kind: "frame" }, { kind: "sticky" }],
			}),
		);
		await h.run();
		// 3 nodes − 2 frames = 1 item.
		expect(h.root.querySelector(".bswb__meta")?.textContent).toBe("1 item · 2 frames");
	});

	it("singularises one item, one frame", async () => {
		const h = makeCtx(board({ name: "Solo", nodes: [{ kind: "frame" }, { kind: "sticky" }] }));
		await h.run();
		expect(h.root.querySelector(".bswb__meta")?.textContent).toBe("1 item · 1 frame");
	});

	it("handles an empty / malformed nodes list", async () => {
		const empty = makeCtx(board({ name: "Empty", nodes: [] }));
		await empty.run();
		expect(empty.root.querySelector(".bswb__meta")?.textContent).toBe("0 items");

		const malformed = makeCtx(board({ name: "Bad", nodes: "not-an-array" }));
		await malformed.run();
		expect(malformed.root.querySelector(".bswb__meta")?.textContent).toBe("0 items");
	});

	it("falls back to 'Untitled board' when the name is missing", async () => {
		const h = makeCtx(board({ nodes: [] }));
		await h.run();
		expect(h.root.querySelector(".bswb__title")?.textContent).toBe("Untitled board");
	});

	it("clicking the card navigates to the board", async () => {
		const h = makeCtx(board({ name: "Roadmap", nodes: [] }));
		await h.run();
		h.root.click();
		expect(h.navigate).toHaveBeenCalledWith("wb-1", WHITEBOARD_TYPE);
	});

	it("reports its content height after rendering", async () => {
		const h = makeCtx(board({ name: "Roadmap", nodes: [] }));
		await h.run();
		expect(h.reportHeight).toHaveBeenCalled();
	});

	it("shows an error card when the board can't be loaded", async () => {
		const h = makeCtx(null);
		await h.run();
		expect(h.root.querySelector(".bswb__error")).not.toBeNull();
		expect(h.navigate).not.toHaveBeenCalled();
		expect(h.reportHeight).toHaveBeenCalled();
	});
});
