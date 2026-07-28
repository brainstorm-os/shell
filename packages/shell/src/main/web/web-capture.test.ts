import { describe, expect, it } from "vitest";
import type { ReadableMeta } from "../network/readable/extract-html";
import {
	CAPTURE_MAX_BLOCKS,
	CAPTURE_PROVENANCE_MACHINE_EXTRACTED,
	CAPTURE_TITLE_MAX_LEN,
	CAPTURE_URL_MAX_LEN,
	captureBookmarkProperties,
	captureUrl,
} from "./web-capture";

const META: ReadableMeta = {
	title: "Extracted title",
	byline: "By Jane Doe",
	siteName: "Example News",
	excerpt: "A short standfirst.",
	lang: "en",
	publishedAt: "2026-01-02T03:04:05.000Z",
};

const BLOCKS = [{ type: "paragraph", version: 1 }];

function bag(overrides: Partial<Parameters<typeof captureBookmarkProperties>[0]> = {}) {
	return captureBookmarkProperties({
		url: "https://example.com/post",
		title: "Tab title",
		meta: META,
		blocks: BLOCKS,
		now: 1_700_000_000_000,
		...overrides,
	});
}

describe("captureUrl", () => {
	it("re-serializes an http(s) URL from the parser, never the raw string", () => {
		expect(captureUrl("https://example.com/a b")).toBe("https://example.com/a%20b");
		expect(captureUrl("http://example.com")).toBe("http://example.com/");
	});

	it("refuses non-web schemes and garbage (fail closed)", () => {
		for (const raw of [
			"about:blank",
			"javascript:alert(1)",
			"file:///etc/passwd",
			"brainstorm://asset/x",
			"data:text/html,hi",
			"not a url",
			"",
		]) {
			expect(captureUrl(raw)).toBeNull();
		}
	});

	it("refuses an oversized URL", () => {
		expect(captureUrl(`https://example.com/${"a".repeat(CAPTURE_URL_MAX_LEN)}`)).toBeNull();
	});
});

describe("captureBookmarkProperties", () => {
	it("returns null for an unclippable page", () => {
		expect(bag({ url: "about:blank" })).toBeNull();
	});

	it("satisfies every field the Bookmarks codec requires", () => {
		expect(bag()).toMatchObject({
			url: "https://example.com/post",
			title: "Tab title",
			faviconUrl: null,
			coverImageUrl: null,
			tags: [],
			savedAt: 1_700_000_000_000,
			readAt: null,
			archivedAt: null,
			colorHint: null,
			createdAt: 1_700_000_000_000,
			updatedAt: 1_700_000_000_000,
		});
	});

	it("stamps the scrape-parity metadata from the extraction", () => {
		expect(bag()).toMatchObject({
			description: "A short standfirst.",
			siteName: "Example News",
			author: "By Jane Doe",
			publishedAt: Date.parse("2026-01-02T03:04:05.000Z"),
		});
	});

	it("omits metadata fields the extraction did not find (never empty strings)", () => {
		const properties = bag({ meta: null, blocks: null });
		expect(properties).not.toBeNull();
		for (const key of ["description", "siteName", "author", "publishedAt"]) {
			expect(properties).not.toHaveProperty(key);
		}
	});

	it("stamps the content triple only for a non-empty block tree", () => {
		expect(bag()).toMatchObject({
			contentBlocks: BLOCKS,
			contentProvenance: CAPTURE_PROVENANCE_MACHINE_EXTRACTED,
			contentFetchedAt: 1_700_000_000_000,
		});
		for (const blocks of [null, []]) {
			const properties = bag({ blocks });
			expect(properties).not.toHaveProperty("contentBlocks");
			expect(properties).not.toHaveProperty("contentProvenance");
			expect(properties).not.toHaveProperty("contentFetchedAt");
		}
	});

	it("hardens page-supplied strings (controls / bidi stripped, length clamped)", () => {
		const properties = bag({
			title: `\u202egnp.eruta\u202c mi${"x".repeat(500)}`,
			meta: {
				...META,
				byline: "Jane\u200b Doe",
				excerpt: `  spaced   out ${"y".repeat(600)}`,
			},
		});
		const title = properties?.title as string;
		expect(title.length).toBeLessThanOrEqual(CAPTURE_TITLE_MAX_LEN);
		expect(title.includes("\u202e")).toBe(false);
		expect(title.includes("\u202c")).toBe(false);
		expect(properties?.author).toBe("Jane Doe");
		expect((properties?.description as string).startsWith("spaced out")).toBe(true);
	});

	it("falls back tab title → extracted title → hostname, never blank", () => {
		expect(bag({ title: "  " })?.title).toBe("Extracted title");
		expect(bag({ title: "\u200b", meta: { ...META, title: null } })?.title).toBe("example.com");
	});

	it("drops an unparseable publish date rather than persisting NaN", () => {
		expect(bag({ meta: { ...META, publishedAt: "not a date" } })).not.toHaveProperty("publishedAt");
	});

	it("caps a pathological block tree", () => {
		const properties = bag({
			blocks: Array.from({ length: CAPTURE_MAX_BLOCKS + 100 }, () => ({
				type: "paragraph",
				version: 1,
			})),
		});
		expect((properties?.contentBlocks as unknown[]).length).toBe(CAPTURE_MAX_BLOCKS);
	});
});
