// @vitest-environment happy-dom
/**
 * `BookmarkCard` object-menu wiring — the React replacement for the old
 * delegated-listener guard. Preserves the same intent: right-clicking the card
 * (or a deep child) opens the shared object menu resolved for THAT bookmark, the
 * card's app-owned `extraItems` / `onRemove` flow through, and a preview-mode
 * context (`null`) is a no-op (no destructive surface).
 */

import { closeObjectMenu } from "@brainstorm-os/sdk/object-menu";
import type { OpenObjectMenuOptions } from "@brainstorm-os/sdk/object-menu";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bookmark } from "../types/bookmark";
import { BOOKMARK_ENTITY_TYPE } from "../types/bookmark";
import { BookmarkSurface } from "../types/surface";
import { BookmarkCard } from "./bookmark-card";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const bookmark = (id: string): Bookmark => ({
	id,
	url: `https://example.test/${id}`,
	title: `Bookmark ${id}`,
	faviconUrl: null,
	coverImageUrl: null,
	tags: ["design"],
	savedAt: 1,
	readAt: null,
	archivedAt: null,
	colorHint: null,
	createdAt: 1,
	updatedAt: 1,
});

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	closeObjectMenu();
	document.body.replaceChildren();
});

function renderCard(menuContext: () => OpenObjectMenuOptions | null): void {
	act(() => {
		root.render(
			<ul>
				<BookmarkCard
					bookmark={bookmark("b")}
					surface={BookmarkSurface.Inbox}
					onOpen={() => {}}
					menuContext={menuContext}
				/>
			</ul>,
		);
	});
}

describe("BookmarkCard object menu", () => {
	it("stamps the card with the bookmark's entity id + type", () => {
		renderCard(() => null);
		const li = container.querySelector<HTMLElement>(".bookmarks__card");
		expect(li?.getAttribute("data-entity-id")).toBe("b");
		expect(li?.getAttribute("data-entity-type")).toBe(BOOKMARK_ENTITY_TYPE);
	});

	it("right-click on a deep child opens the menu resolved for that bookmark", async () => {
		const onRemove = vi.fn();
		const context = vi.fn(
			(): OpenObjectMenuOptions => ({
				target: { entityId: "b", entityType: BOOKMARK_ENTITY_TYPE, label: "Bookmark b" },
				runtime: { capabilities: [], services: {} },
				extraItems: [{ id: "edit-tags", label: "Edit tags", run: () => {} }],
				onRemove,
			}),
		);
		renderCard(context);
		const title = container.querySelector(".bookmarks__card-title");
		await act(async () => {
			title?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
			await Promise.resolve();
		});
		expect(context).toHaveBeenCalled();
		const menu = document.querySelector(".bs-object-menu");
		expect(menu).not.toBeNull();
		const editRow = [...(menu?.querySelectorAll("button") ?? [])].find((b) =>
			b.textContent?.includes("Edit tags"),
		);
		expect(editRow).toBeDefined();
	});

	it("no-ops in preview mode (null context)", async () => {
		const context = vi.fn(() => null);
		renderCard(context);
		const li = container.querySelector(".bookmarks__card");
		await act(async () => {
			li?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
			await Promise.resolve();
		});
		expect(document.querySelector(".bs-object-menu")).toBeNull();
	});
});

describe("BookmarkCard thumbnail", () => {
	function renderBookmark(b: Bookmark): void {
		act(() => {
			root.render(
				<ul>
					<BookmarkCard
						bookmark={b}
						surface={BookmarkSurface.Inbox}
						onOpen={() => {}}
						menuContext={() => null}
					/>
				</ul>,
			);
		});
	}

	it("renders the bare neutral tile (no seeded-gradient swatch) when the bookmark has no cover", () => {
		renderBookmark(bookmark("b"));
		const thumb = container.querySelector(".bookmarks__card-thumb");
		expect(thumb?.classList.contains("bookmarks__card-thumb--bare")).toBe(true);
		expect(container.querySelector(".bookmarks__card-swatch")).toBeNull();
	});

	it("paints the cover swatch when the bookmark carries a captured image", () => {
		renderBookmark({ ...bookmark("c"), coverImageUrl: "https://img.test/c.png" });
		const thumb = container.querySelector(".bookmarks__card-thumb");
		expect(thumb?.classList.contains("bookmarks__card-thumb--bare")).toBe(false);
		expect(container.querySelector(".bookmarks__card-swatch")).not.toBeNull();
	});
});
