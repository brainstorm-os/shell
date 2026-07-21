import type { SerializedBlock } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	BOOKMARK_ENTITY_TYPE,
	CLIP_TITLE_MAX_LEN,
	CLIP_URL_MAX_LEN,
	CONTENT_PROVENANCE_MACHINE_EXTRACTED,
	ClipPhase,
	canClip,
	clipBookmarkProperties,
	clipPhaseFor,
	clippableUrl,
} from "./clip";

const RLO = String.fromCharCode(0x202e);
const NUL = String.fromCharCode(0x00);

describe("clippableUrl", () => {
	it("accepts http and https URLs and re-serializes them", () => {
		expect(clippableUrl("https://example.com/a?b=1#c")).toBe("https://example.com/a?b=1#c");
		expect(clippableUrl("http://example.com")).toBe("http://example.com/");
	});

	it("rejects non-web schemes and unparsable input", () => {
		expect(clippableUrl("about:blank")).toBeNull();
		expect(clippableUrl("file:///etc/passwd")).toBeNull();
		expect(clippableUrl("javascript:alert(1)")).toBeNull();
		expect(clippableUrl("chrome://settings")).toBeNull();
		expect(clippableUrl("not a url")).toBeNull();
		expect(clippableUrl("")).toBeNull();
	});

	it("rejects URLs over the length bound", () => {
		const long = `https://example.com/${"a".repeat(CLIP_URL_MAX_LEN)}`;
		expect(clippableUrl(long)).toBeNull();
	});

	it("percent-encodes rather than passing raw control characters", () => {
		const url = clippableUrl("https://example.com/a b");
		expect(url).toBe("https://example.com/a%20b");
	});
});

describe("clipPhaseFor", () => {
	it("is Idle with no attempt or no active tab", () => {
		expect(clipPhaseFor(null, "t1")).toBe(ClipPhase.Idle);
		expect(clipPhaseFor({ tabId: "t1", phase: ClipPhase.Saved }, null)).toBe(ClipPhase.Idle);
	});

	it("returns the attempt's phase only for the attempt's tab", () => {
		const attempt = { tabId: "t1", phase: ClipPhase.Saved };
		expect(clipPhaseFor(attempt, "t1")).toBe(ClipPhase.Saved);
		expect(clipPhaseFor(attempt, "t2")).toBe(ClipPhase.Idle);
	});
});

describe("canClip", () => {
	it("requires a clippable URL", () => {
		expect(canClip("https://example.com", ClipPhase.Idle)).toBe(true);
		expect(canClip("about:blank", ClipPhase.Idle)).toBe(false);
		expect(canClip(undefined, ClipPhase.Idle)).toBe(false);
	});

	it("is disabled while a save is in flight, re-enabled after", () => {
		expect(canClip("https://example.com", ClipPhase.Saving)).toBe(false);
		expect(canClip("https://example.com", ClipPhase.Saved)).toBe(true);
		expect(canClip("https://example.com", ClipPhase.Failed)).toBe(true);
	});
});

describe("clipBookmarkProperties", () => {
	const now = 1718000000000;

	it("maps page metadata onto the Bookmark/v1 property shape", () => {
		const props = clipBookmarkProperties(
			{ url: "https://example.com/article", title: "Example Article" },
			now,
		);
		expect(props).toEqual({
			url: "https://example.com/article",
			title: "Example Article",
			faviconUrl: null,
			coverImageUrl: null,
			tags: [],
			savedAt: now,
			readAt: null,
			archivedAt: null,
			colorHint: null,
			createdAt: now,
			updatedAt: now,
		});
	});

	it("uses the canonical type id", () => {
		expect(BOOKMARK_ENTITY_TYPE).toBe("brainstorm/Bookmark/v1");
	});

	it("returns null for a non-clippable URL", () => {
		expect(clipBookmarkProperties({ url: "about:blank", title: "x" }, now)).toBeNull();
	});

	it("sanitizes the page-supplied title (controls + bidi stripped, whitespace collapsed)", () => {
		const props = clipBookmarkProperties(
			{ url: "https://example.com", title: `  Hello${NUL} ${RLO} \n world  ` },
			now,
		);
		expect(props?.title).toBe("Hello world");
	});

	it("clamps the title to the length bound", () => {
		const props = clipBookmarkProperties(
			{ url: "https://example.com", title: "t".repeat(CLIP_TITLE_MAX_LEN * 2) },
			now,
		);
		expect(props?.title).toHaveLength(CLIP_TITLE_MAX_LEN);
	});

	it("falls back to the hostname when the title is empty or fully stripped", () => {
		expect(clipBookmarkProperties({ url: "https://example.com/x", title: "" }, now)?.title).toBe(
			"example.com",
		);
		expect(
			clipBookmarkProperties({ url: "https://example.com/x", title: `${NUL}${RLO}  ` }, now)?.title,
		).toBe("example.com");
	});

	it("never persists a remote favicon (offline-first asset contract)", () => {
		const props = clipBookmarkProperties({ url: "https://example.com", title: "t" }, now);
		expect(props?.faviconUrl).toBeNull();
		expect(props?.coverImageUrl).toBeNull();
	});

	// F-235: a clip with no capture saved blank page content. The pure core must
	// stamp the captured body so the Bookmarks detail renders it.
	it("stamps captured content blocks + provenance + fetched-at (F-235)", () => {
		const blocks: SerializedBlock[] = [
			{ type: "heading", text: "Title" } as unknown as SerializedBlock,
			{ type: "paragraph", text: "Body" } as unknown as SerializedBlock,
		];
		const props = clipBookmarkProperties(
			{ url: "https://example.com/article", title: "Article" },
			now,
			{ blocks },
		);
		expect(props?.contentBlocks).toBe(blocks);
		expect(props?.contentProvenance).toBe(CONTENT_PROVENANCE_MACHINE_EXTRACTED);
		expect(props?.contentFetchedAt).toBe(now);
	});

	it("uses the canonical machine-extracted provenance wire token", () => {
		expect(CONTENT_PROVENANCE_MACHINE_EXTRACTED).toBe("machine-extracted");
	});

	it("leaves a link-only bookmark when the capture is absent, null, or empty", () => {
		for (const capture of [undefined, { blocks: null }, { blocks: [] }]) {
			const props = clipBookmarkProperties({ url: "https://example.com", title: "t" }, now, capture);
			expect(props).not.toHaveProperty("contentBlocks");
			expect(props).not.toHaveProperty("contentProvenance");
			expect(props).not.toHaveProperty("contentFetchedAt");
		}
	});
});
