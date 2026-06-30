import { IconKind } from "@brainstorm/sdk-types";
import { describe, expect, it } from "vitest";
import { BOOKMARK_KEY_PREFIX, bookmarkKey, parseStoredBookmark, serializeBookmark } from "./codec";

const BASE = {
	id: "b1",
	url: "https://example.com",
	title: "Example",
	icon: null,
	faviconUrl: null,
	coverImageUrl: null,
	tags: [],
	savedAt: 1700000000000,
	readAt: null,
	archivedAt: null,
	colorHint: null,
	createdAt: 1700000000000,
	updatedAt: 1700000000000,
} as const;

describe("bookmarkKey", () => {
	it("prefixes the id", () => {
		expect(bookmarkKey("abc")).toBe("bookmark:abc");
		expect(BOOKMARK_KEY_PREFIX).toBe("bookmark:");
	});
});

describe("serializeBookmark", () => {
	it("returns a structural clone", () => {
		const out = serializeBookmark({ ...BASE });
		expect(out).toEqual(BASE);
		expect(out).not.toBe(BASE);
	});

	it("strips the transient store revision from the on-disk shape", () => {
		const out = serializeBookmark({ ...BASE, rev: 42 });
		expect(out).not.toHaveProperty("rev");
		expect(out).toEqual(BASE);
	});
});

describe("parseStoredBookmark", () => {
	it("returns null for non-objects", () => {
		expect(parseStoredBookmark(null)).toBeNull();
		expect(parseStoredBookmark(undefined)).toBeNull();
		expect(parseStoredBookmark("string")).toBeNull();
		expect(parseStoredBookmark(42)).toBeNull();
	});

	it("returns null when id / url / title / createdAt are missing or wrong-typed", () => {
		expect(parseStoredBookmark({ ...BASE, id: "" })).toBeNull();
		expect(parseStoredBookmark({ ...BASE, url: 42 })).toBeNull();
		expect(parseStoredBookmark({ ...BASE, title: null })).toBeNull();
		expect(parseStoredBookmark({ ...BASE, createdAt: Number.NaN })).toBeNull();
	});

	it("defaults savedAt to createdAt when absent or non-numeric (welcome-seed bookmark)", () => {
		// A non-numeric savedAt no longer drops the whole row — it falls back to
		// the creation time (the welcome "help & docs" bookmark ships no savedAt
		// and was invisible in the app while Database/Graph showed it).
		const nonNumeric = parseStoredBookmark({ ...BASE, savedAt: "later", createdAt: 222 });
		expect(nonNumeric).not.toBeNull();
		expect(nonNumeric?.savedAt).toBe(222);

		const absent: Record<string, unknown> = { ...BASE, createdAt: 333 };
		absent.savedAt = undefined;
		expect(parseStoredBookmark(absent)?.savedAt).toBe(333);
	});

	it("rejects URLs that don't normalize (non-http schemes etc.)", () => {
		expect(parseStoredBookmark({ ...BASE, url: "mailto:hi@x.com" })).toBeNull();
		expect(parseStoredBookmark({ ...BASE, url: "javascript:alert(1)" })).toBeNull();
		expect(parseStoredBookmark({ ...BASE, url: "" })).toBeNull();
	});

	it("normalizes the URL on parse", () => {
		const out = parseStoredBookmark({ ...BASE, url: "HTTPS://EXAMPLE.com/" });
		expect(out?.url).toBe("https://example.com");
	});

	it("round-trips a user-chosen cover and drops a malformed one", () => {
		const gradient = parseStoredBookmark({
			...BASE,
			cover: { kind: "gradient", value: "coral" },
		});
		expect(gradient?.cover).toEqual({ kind: "gradient", value: "coral" });

		const image = parseStoredBookmark({
			...BASE,
			cover: { kind: "image", value: "brainstorm://cover/abc.png" },
		});
		expect(image?.cover).toEqual({ kind: "image", value: "brainstorm://cover/abc.png" });

		// No cover field → undefined (falls back to the scraped image / gradient).
		expect(parseStoredBookmark({ ...BASE })?.cover).toBeUndefined();
		// Malformed cover → dropped, not poisoning the row.
		expect(parseStoredBookmark({ ...BASE, cover: { kind: "nope" } })?.cover).toBeUndefined();
	});

	it("normalizes the tag list (lowercase + dedup)", () => {
		const out = parseStoredBookmark({ ...BASE, tags: ["Work", "work", "URGENT  task"] });
		expect(out?.tags).toEqual(["work", "urgent-task"]);
	});

	it("coerces nullable scalar fields safely", () => {
		const out = parseStoredBookmark({
			...BASE,
			readAt: 1700000005000,
			archivedAt: null,
			faviconUrl: undefined,
			colorHint: 42,
		});
		expect(out?.readAt).toBe(1700000005000);
		expect(out?.archivedAt).toBeNull();
		expect(out?.faviconUrl).toBeNull();
		expect(out?.colorHint).toBeNull();
	});

	it("preserves description + notes when supplied", () => {
		const out = parseStoredBookmark({ ...BASE, description: "Quick note", notes: "Read later" });
		expect(out?.description).toBe("Quick note");
		expect(out?.notes).toBe("Read later");
	});

	it("preserves siteName (9.18.6 OG scrape) and ignores a non-string", () => {
		expect(parseStoredBookmark({ ...BASE, siteName: "The Daily Example" })?.siteName).toBe(
			"The Daily Example",
		);
		expect(parseStoredBookmark({ ...BASE, siteName: 42 })?.siteName).toBeUndefined();
		expect(parseStoredBookmark({ ...BASE })?.siteName).toBeUndefined();
		// Round-trips through serialize.
		const bm = parseStoredBookmark({ ...BASE, siteName: "Example Site" });
		if (!bm) throw new Error("expected a parsed bookmark");
		expect(serializeBookmark(bm).siteName).toBe("Example Site");
	});

	it("preserves mediaType (og:type) and ignores a non-string", () => {
		expect(parseStoredBookmark({ ...BASE, mediaType: "article" })?.mediaType).toBe("article");
		expect(parseStoredBookmark({ ...BASE, mediaType: 42 })?.mediaType).toBeUndefined();
		expect(parseStoredBookmark({ ...BASE })?.mediaType).toBeUndefined();
		const bm = parseStoredBookmark({ ...BASE, mediaType: "video.movie" });
		if (!bm) throw new Error("expected a parsed bookmark");
		expect(serializeBookmark(bm).mediaType).toBe("video.movie");
	});

	it("preserves author (9.18.6 OG scrape) and ignores a non-string", () => {
		expect(parseStoredBookmark({ ...BASE, author: "Jane Doe" })?.author).toBe("Jane Doe");
		expect(parseStoredBookmark({ ...BASE, author: 42 })?.author).toBeUndefined();
		expect(parseStoredBookmark({ ...BASE })?.author).toBeUndefined();
		const bm = parseStoredBookmark({ ...BASE, author: "Ada" });
		if (!bm) throw new Error("expected a parsed bookmark");
		expect(serializeBookmark(bm).author).toBe("Ada");
	});

	it("preserves publishedAt (article:published_time) and ignores non-finite numbers", () => {
		expect(parseStoredBookmark({ ...BASE, publishedAt: 1699999999000 })?.publishedAt).toBe(
			1699999999000,
		);
		expect(parseStoredBookmark({ ...BASE, publishedAt: "nope" })?.publishedAt).toBeUndefined();
		expect(parseStoredBookmark({ ...BASE, publishedAt: Number.NaN })?.publishedAt).toBeUndefined();
		expect(parseStoredBookmark({ ...BASE })?.publishedAt).toBeUndefined();
		const bm = parseStoredBookmark({ ...BASE, publishedAt: 1700000001000 });
		if (!bm) throw new Error("expected a parsed bookmark");
		expect(serializeBookmark(bm).publishedAt).toBe(1700000001000);
	});

	it("round-trips captured contentBlocks + contentFetchedAt; drops a malformed array", () => {
		const blocks = [
			{ type: "heading", version: 1, tag: "h1", children: [] },
			{ type: "paragraph", version: 1, children: [] },
		];
		const out = parseStoredBookmark({
			...BASE,
			contentBlocks: blocks,
			contentFetchedAt: 1700000009000,
		});
		expect(out?.contentBlocks).toHaveLength(2);
		expect(out?.contentFetchedAt).toBe(1700000009000);
		if (!out) throw new Error("expected a parsed bookmark");
		expect(serializeBookmark(out).contentBlocks).toHaveLength(2);
		// A block missing a string `type` ⇒ the whole array is dropped.
		expect(
			parseStoredBookmark({ ...BASE, contentBlocks: [{ version: 1 }] })?.contentBlocks,
		).toBeUndefined();
		expect(parseStoredBookmark({ ...BASE, contentBlocks: "nope" })?.contentBlocks).toBeUndefined();
	});

	it("round-trips a known contentProvenance and drops an unknown one (9.18.13)", () => {
		const blocks = [{ type: "paragraph", version: 1, children: [] }];
		const machine = parseStoredBookmark({
			...BASE,
			contentBlocks: blocks,
			contentFetchedAt: 1700000009000,
			contentProvenance: "machine-extracted",
		});
		expect(machine?.contentProvenance).toBe("machine-extracted");
		// An unrecognised token drops to absent (forward-compatible).
		const unknown = parseStoredBookmark({
			...BASE,
			contentBlocks: blocks,
			contentProvenance: "from-the-future",
		});
		expect(unknown?.contentProvenance).toBeUndefined();
		// Provenance without captured content is ignored (it rides the block array).
		const noBlocks = parseStoredBookmark({ ...BASE, contentProvenance: "machine-extracted" });
		expect(noBlocks?.contentProvenance).toBeUndefined();
	});

	it("round-trips contentFetchedAt with no contentBlocks (no-readable-body capture, F-243)", () => {
		const out = parseStoredBookmark({ ...BASE, contentFetchedAt: 1700000009000 });
		expect(out?.contentFetchedAt).toBe(1700000009000);
		expect(out?.contentBlocks).toBeUndefined();
		if (!out) throw new Error("expected a parsed bookmark");
		expect(serializeBookmark(out).contentFetchedAt).toBe(1700000009000);
		// A non-finite stamp drops to absent.
		expect(
			parseStoredBookmark({ ...BASE, contentFetchedAt: Number.NaN })?.contentFetchedAt,
		).toBeUndefined();
	});

	it("drops description / notes when wrong-typed", () => {
		const out = parseStoredBookmark({ ...BASE, description: 42, notes: null });
		expect(out?.description).toBeUndefined();
		expect(out?.notes).toBeUndefined();
	});

	it("ignores non-string tags + filters them out before normalization", () => {
		const out = parseStoredBookmark({ ...BASE, tags: ["valid", 42, null, "  "] });
		expect(out?.tags).toEqual(["valid"]);
	});

	it("round-trips a user-picked emoji icon — the icon survives the broadcast→listAll refresh", () => {
		const emoji = { kind: IconKind.Emoji, value: "🔖" };
		const out = parseStoredBookmark({ ...BASE, icon: emoji });
		expect(out?.icon).toEqual(emoji);
	});

	it("drops a malformed icon to null rather than poisoning the row", () => {
		expect(parseStoredBookmark({ ...BASE, icon: { kind: "WAT", value: "x" } })?.icon).toBeNull();
		expect(parseStoredBookmark({ ...BASE, icon: "raw-emoji" })?.icon).toBeNull();
	});
});
