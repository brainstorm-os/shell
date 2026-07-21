import type { LinkPreview } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import type { Bookmark } from "../types/bookmark";
import {
	metadataBackfill,
	preferScrapedAuthor,
	preferScrapedPublishedAt,
	preferScrapedTitle,
} from "./enrich";

const URL = "https://en.wikipedia.org/wiki/Pope_Leo_XIV";

type BackfillSource = Parameters<typeof metadataBackfill>[0];

const bookmarkSource = (over: Partial<BackfillSource> = {}): BackfillSource => ({
	title: "en.wikipedia.org",
	url: URL,
	faviconUrl: null,
	coverImageUrl: null,
	...over,
});

const preview = (over: Partial<LinkPreview> = {}): LinkPreview => ({
	url: URL,
	canonicalUrl: URL,
	title: "",
	description: "",
	image: "",
	favicon: "",
	siteName: "",
	mediaType: "page",
	fetchedAt: 0,
	...over,
});

describe("preferScrapedTitle", () => {
	it("replaces the domain-default title (user typed none)", () => {
		// composeBookmark defaults a blank title to the domain.
		expect(preferScrapedTitle("en.wikipedia.org", URL, "Pope Leo XIV - Wikipedia")).toBe(
			"Pope Leo XIV - Wikipedia",
		);
	});

	it("replaces a blank title", () => {
		expect(preferScrapedTitle("", URL, "Pope Leo XIV - Wikipedia")).toBe("Pope Leo XIV - Wikipedia");
		expect(preferScrapedTitle("   ", URL, "Pope Leo XIV - Wikipedia")).toBe(
			"Pope Leo XIV - Wikipedia",
		);
	});

	it("preserves a user-chosen title", () => {
		expect(
			preferScrapedTitle("My reading on the new pope", URL, "Pope Leo XIV - Wikipedia"),
		).toBeNull();
	});

	it("returns null when the scrape has no title", () => {
		expect(preferScrapedTitle("en.wikipedia.org", URL, "")).toBeNull();
	});

	it("returns null when the scraped title already matches", () => {
		expect(
			preferScrapedTitle("Pope Leo XIV - Wikipedia", URL, "Pope Leo XIV - Wikipedia"),
		).toBeNull();
	});
});

describe("preferScrapedAuthor", () => {
	it("backfills when the bookmark has no author", () => {
		expect(preferScrapedAuthor(undefined, "Jane Doe")).toBe("Jane Doe");
		expect(preferScrapedAuthor("", "Jane Doe")).toBe("Jane Doe");
		expect(preferScrapedAuthor("   ", "Jane Doe")).toBe("Jane Doe");
	});

	it("never clobbers a user-set author", () => {
		expect(preferScrapedAuthor("My Author", "Jane Doe")).toBeNull();
	});

	it("keeps the current value when the scrape found nothing", () => {
		expect(preferScrapedAuthor(undefined, undefined)).toBeNull();
		expect(preferScrapedAuthor(undefined, "")).toBeNull();
		expect(preferScrapedAuthor(undefined, "   ")).toBeNull();
	});

	it("trims the scraped value", () => {
		expect(preferScrapedAuthor(undefined, "  Jane Doe ")).toBe("Jane Doe");
	});
});

describe("preferScrapedPublishedAt", () => {
	it("backfills when the bookmark has no publish date", () => {
		expect(preferScrapedPublishedAt(undefined, 1700000000000)).toBe(1700000000000);
	});

	it("never clobbers a user-set publish date", () => {
		expect(preferScrapedPublishedAt(1600000000000, 1700000000000)).toBeNull();
	});

	it("drops an absent / non-finite scrape", () => {
		expect(preferScrapedPublishedAt(undefined, undefined)).toBeNull();
		expect(preferScrapedPublishedAt(undefined, Number.NaN)).toBeNull();
		expect(preferScrapedPublishedAt(undefined, Number.POSITIVE_INFINITY)).toBeNull();
	});
});

describe("metadataBackfill", () => {
	// F-243: a capture that recovers preview metadata but no readable body
	// still becomes a rich link — these are the fields that ride along.
	it("backfills title / site / description / cover / favicon / citation basics", () => {
		const backfill = metadataBackfill(
			bookmarkSource(),
			preview({
				title: "Pope Leo XIV - Wikipedia",
				siteName: "Wikipedia",
				description: "The 267th pope.",
				faviconAssetUrl: "brainstorm://asset/favicon",
				coverAssetUrl: "brainstorm://asset/cover",
				mediaType: "article",
				author: "Jane Doe",
				publishedAt: 1700000000000,
			}),
		);
		expect(backfill).toEqual({
			title: "Pope Leo XIV - Wikipedia",
			siteName: "Wikipedia",
			description: "The 267th pope.",
			faviconUrl: "brainstorm://asset/favicon",
			coverImageUrl: "brainstorm://asset/cover",
			mediaType: "article",
			author: "Jane Doe",
			publishedAt: 1700000000000,
		} satisfies Partial<Bookmark>);
	});

	it("returns null when the preview adds nothing", () => {
		expect(metadataBackfill(bookmarkSource(), preview())).toBeNull();
	});

	it("never clobbers user-set fields (backfill-only)", () => {
		const backfill = metadataBackfill(
			bookmarkSource({
				title: "My reading on the new pope",
				description: "my own note",
				coverImageUrl: "brainstorm://asset/mine",
				author: "My Author",
				publishedAt: 1600000000000,
			}),
			preview({
				title: "Pope Leo XIV - Wikipedia",
				description: "The 267th pope.",
				coverAssetUrl: "brainstorm://asset/scraped",
				author: "Jane Doe",
				publishedAt: 1700000000000,
				siteName: "Wikipedia",
			}),
		);
		expect(backfill).toEqual({ siteName: "Wikipedia" } satisfies Partial<Bookmark>);
	});

	it("skips the generic 'page' mediaType fallback", () => {
		expect(metadataBackfill(bookmarkSource(), preview({ mediaType: "page" }))).toBeNull();
	});

	it("treats a whitespace-only scraped description as absent (no churn)", () => {
		expect(metadataBackfill(bookmarkSource(), preview({ description: "   \n\t" }))).toBeNull();
	});

	it("trims a scraped description before backfilling", () => {
		const backfill = metadataBackfill(
			bookmarkSource(),
			preview({ description: "  The 267th pope.  " }),
		);
		expect(backfill).toEqual({ description: "The 267th pope." } satisfies Partial<Bookmark>);
	});
});
