import type { SerializedBlock } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { collectRemoteImageSrcs, isRemoteHttpImageSrc, rewriteImageSrcs } from "./enrich-blocks";

function img(src: string): SerializedBlock {
	return {
		type: "image",
		version: 1,
		src,
		altText: "",
		caption: "",
		width: "inherit",
	} as SerializedBlock;
}
function para(children: SerializedBlock[] = []): SerializedBlock {
	return { type: "paragraph", version: 1, children } as unknown as SerializedBlock;
}

describe("isRemoteHttpImageSrc", () => {
	it("accepts http(s), rejects local/other schemes + non-strings", () => {
		expect(isRemoteHttpImageSrc("https://x.com/a.png")).toBe(true);
		expect(isRemoteHttpImageSrc("http://x.com/a.png")).toBe(true);
		expect(isRemoteHttpImageSrc("brainstorm://asset/abc")).toBe(false);
		expect(isRemoteHttpImageSrc("data:image/png;base64,AAA")).toBe(false);
		expect(isRemoteHttpImageSrc(42)).toBe(false);
		expect(isRemoteHttpImageSrc(undefined)).toBe(false);
	});
});

describe("collectRemoteImageSrcs", () => {
	it("collects distinct remote image srcs, recursing into children", () => {
		const blocks = [
			img("https://x.com/a.png"),
			para([img("https://x.com/b.png"), para([img("https://x.com/a.png")])]),
			para([{ type: "text", version: 1 } as SerializedBlock]),
		];
		expect(collectRemoteImageSrcs(blocks, 40).sort()).toEqual([
			"https://x.com/a.png",
			"https://x.com/b.png",
		]);
	});

	it("ignores already-local, data, and non-image blocks", () => {
		const blocks = [
			img("brainstorm://asset/xyz"),
			img("data:image/png;base64,AAA"),
			{ type: "paragraph", version: 1, src: "https://x.com/not-an-image.png" } as SerializedBlock,
		];
		expect(collectRemoteImageSrcs(blocks, 40)).toEqual([]);
	});

	it("caps the count at `max` — a hostile page can't drive unbounded fetches", () => {
		const many = Array.from({ length: 100 }, (_, i) => img(`https://x.com/${i}.png`));
		expect(collectRemoteImageSrcs(many, 40)).toHaveLength(40);
	});
});

describe("rewriteImageSrcs", () => {
	it("rewrites mapped srcs, leaves unmapped remote images untouched, recurses", () => {
		const blocks = [img("https://x.com/a.png"), para([img("https://x.com/b.png")])];
		const map = new Map([["https://x.com/a.png", "brainstorm://asset/a1"]]);
		const out = rewriteImageSrcs(blocks, map);
		expect((out[0] as unknown as { src: string }).src).toBe("brainstorm://asset/a1");
		// unmapped (fetch failed) keeps its remote src → dropped at render
		const nested = (out[1] as unknown as { children: { src: string }[] }).children[0];
		expect(nested?.src).toBe("https://x.com/b.png");
	});

	it("returns the input unchanged for an empty rewrite map", () => {
		const blocks = [img("https://x.com/a.png")];
		expect(rewriteImageSrcs(blocks, new Map())).toBe(blocks);
	});
});
