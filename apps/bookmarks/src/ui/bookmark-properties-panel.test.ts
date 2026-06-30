// @vitest-environment happy-dom
import { DictionaryStore, PropertiesContext } from "@brainstorm/sdk/property-ui";
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOOKMARK_PROP_KEY } from "../properties/bookmark-properties";
import type { Bookmark } from "../types/bookmark";
import { BookmarkPropertiesPanel, isVisibleScrapeRow } from "./bookmark-properties-panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BASE: Bookmark = {
	id: "b1",
	url: "https://example.test/article",
	title: "An article",
	faviconUrl: null,
	coverImageUrl: null,
	tags: [],
	savedAt: 1,
	readAt: null,
	archivedAt: null,
	colorHint: null,
	createdAt: 1,
	updatedAt: 1,
};

describe("isVisibleScrapeRow", () => {
	it("hides the derived Type row when the page declared no og:type", () => {
		expect(isVisibleScrapeRow(BOOKMARK_PROP_KEY.type, BASE)).toBe(false);
	});

	it("shows Type once the scrape populated it", () => {
		expect(isVisibleScrapeRow(BOOKMARK_PROP_KEY.type, { ...BASE, mediaType: "article" })).toBe(true);
	});

	it("always shows Author + Published, even when the scraper found none (F-204)", () => {
		expect(isVisibleScrapeRow(BOOKMARK_PROP_KEY.author, BASE)).toBe(true);
		expect(isVisibleScrapeRow(BOOKMARK_PROP_KEY.published, BASE)).toBe(true);
		expect(isVisibleScrapeRow(BOOKMARK_PROP_KEY.author, { ...BASE, author: "Jane Doe" })).toBe(true);
		expect(
			isVisibleScrapeRow(BOOKMARK_PROP_KEY.published, { ...BASE, publishedAt: 1699999999000 }),
		).toBe(true);
	});

	it("always shows non-scrape rows (url/site/tags/saved/read/archived/description/notes)", () => {
		for (const key of [
			BOOKMARK_PROP_KEY.url,
			BOOKMARK_PROP_KEY.site,
			BOOKMARK_PROP_KEY.author,
			BOOKMARK_PROP_KEY.tags,
			BOOKMARK_PROP_KEY.saved,
			BOOKMARK_PROP_KEY.read,
			BOOKMARK_PROP_KEY.archived,
			BOOKMARK_PROP_KEY.description,
			BOOKMARK_PROP_KEY.notes,
		]) {
			expect(isVisibleScrapeRow(key, BASE)).toBe(true);
		}
	});
});

describe("BookmarkPropertiesPanel — Author / Published editing (F-204)", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => root.unmount());
		container.remove();
		document.body.innerHTML = "";
	});

	function renderPanel(bookmark: Bookmark, onChange: (partial: Partial<Bookmark>) => void): void {
		const dictionaryStore = new DictionaryStore({
			backend: {
				setDictionary: vi.fn().mockResolvedValue(undefined),
				removeDictionary: vi.fn().mockResolvedValue(undefined),
			},
		});
		act(() => {
			root.render(
				createElement(
					PropertiesContext.Provider,
					{ value: { propertyStore: null as never, dictionaryStore, ready: true } },
					createElement(BookmarkPropertiesPanel, {
						bookmark,
						open: true,
						onChange,
						onClose: () => {},
					}),
				),
			);
		});
	}

	const row = (key: string): HTMLElement | null =>
		container.querySelector<HTMLElement>(`[data-property-key="${key}"]`);

	it("renders empty Author + Published rows with the shared Empty placeholder", () => {
		renderPanel(BASE, () => {});
		const author = row(BOOKMARK_PROP_KEY.author);
		const published = row(BOOKMARK_PROP_KEY.published);
		expect(author).not.toBeNull();
		expect(published).not.toBeNull();
		expect(author?.querySelector(".bs-cell-pill--empty")).not.toBeNull();
		expect(published?.querySelector(".bs-cell-date-empty")).not.toBeNull();
	});

	it("commits a typed author through the shared text cell", () => {
		const onChange = vi.fn();
		renderPanel(BASE, onChange);
		const trigger = row(BOOKMARK_PROP_KEY.author)?.querySelector<HTMLButtonElement>(".bs-cell-pill");
		expect(trigger?.disabled).toBe(false);
		act(() => trigger?.click());
		const input = row(BOOKMARK_PROP_KEY.author)?.querySelector<HTMLInputElement>(".bs-cell-input");
		if (!input) throw new Error("author cell did not enter edit mode");
		act(() => {
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
			setter?.call(input, "Jane Doe");
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
		expect(onChange).toHaveBeenCalledWith({ author: "Jane Doe" });
	});

	it("commits a picked published date through the shared date cell", () => {
		const onChange = vi.fn();
		renderPanel(BASE, onChange);
		const trigger = row(BOOKMARK_PROP_KEY.published)?.querySelector<HTMLElement>(
			".bs-cell-date-trigger",
		);
		if (!trigger) throw new Error("published date trigger missing");
		act(() => trigger.click());
		// The popover portals to <body>; pick the first in-month day.
		const day = document.querySelector<HTMLButtonElement>(
			".bs-cell-cal-day:not(.bs-cell-cal-day--muted)",
		);
		if (!day) throw new Error("date popover did not open");
		act(() => day.click());
		expect(onChange).toHaveBeenCalledTimes(1);
		const partial = onChange.mock.calls[0]?.[0] as Partial<Bookmark>;
		expect(typeof partial.publishedAt).toBe("number");
	});

	it("renders committed values after a reopen (round-trip)", () => {
		renderPanel({ ...BASE, author: "Jane Doe", publishedAt: 1699999999000 }, () => {});
		expect(row(BOOKMARK_PROP_KEY.author)?.textContent).toContain("Jane Doe");
		expect(row(BOOKMARK_PROP_KEY.published)?.querySelector(".bs-cell-date-value")).not.toBeNull();
		expect(row(BOOKMARK_PROP_KEY.published)?.querySelector(".bs-cell-date-empty")).toBeNull();
	});

	it("paints every editable row read-only when the bookmark is locked", () => {
		const onChange = vi.fn();
		renderPanel({ ...BASE, locked: true }, onChange);
		const trigger = row(BOOKMARK_PROP_KEY.author)?.querySelector<HTMLButtonElement>(".bs-cell-pill");
		expect(trigger?.disabled).toBe(true);
		// A read-only cell never opens its editor, so nothing commits.
		act(() => trigger?.click());
		expect(row(BOOKMARK_PROP_KEY.author)?.querySelector(".bs-cell-input")).toBeNull();
		expect(onChange).not.toHaveBeenCalled();
	});
});
