/**
 * Asset-B4b — thumbnailer policy: eligibility gating, keep-or-drop, and the
 * fail-soft posture around the native binding (injected fake — the transform
 * itself is pinned by `packages/native-image/test`).
 */
import { describe, expect, it, vi } from "vitest";
import {
	THUMBNAIL_JPEG_QUALITY,
	THUMBNAIL_MAX_EDGE,
	THUMBNAIL_MIN_SOURCE_BYTES,
	createNativeThumbnailer,
	isThumbnailableMime,
} from "./thumbnailer";

const BIG = new Uint8Array(THUMBNAIL_MIN_SOURCE_BYTES + 1).fill(7);

function fakeModule(result: { bytes: Buffer; mime: string } | Error) {
	const imageThumbnail = vi.fn(async () => {
		if (result instanceof Error) throw result;
		return result;
	});
	return { imageThumbnail };
}

describe("isThumbnailableMime", () => {
	it("accepts the raster set, rejects script-capable and undecodable types", () => {
		expect(isThumbnailableMime("image/png")).toBe(true);
		expect(isThumbnailableMime("image/JPEG")).toBe(true);
		expect(isThumbnailableMime("image/svg+xml")).toBe(false);
		expect(isThumbnailableMime("image/avif")).toBe(false);
		expect(isThumbnailableMime("application/pdf")).toBe(false);
		expect(isThumbnailableMime("text/html")).toBe(false);
	});
});

describe("createNativeThumbnailer", () => {
	it("derives for an eligible source and passes the pinned bounds", async () => {
		const native = fakeModule({ bytes: Buffer.from([1, 2, 3]), mime: "image/jpeg" });
		const thumb = createNativeThumbnailer(async () => native);
		const result = await thumb(BIG, "image/png");
		expect(result).toEqual({ bytes: new Uint8Array([1, 2, 3]), mime: "image/jpeg" });
		expect(native.imageThumbnail).toHaveBeenCalledWith(
			expect.any(Buffer),
			THUMBNAIL_MAX_EDGE,
			THUMBNAIL_JPEG_QUALITY,
		);
	});

	it("skips non-image mimes and small sources without touching the addon", async () => {
		const native = fakeModule({ bytes: Buffer.from([1]), mime: "image/jpeg" });
		const thumb = createNativeThumbnailer(async () => native);
		expect(await thumb(BIG, "application/pdf")).toBeNull();
		expect(await thumb(new Uint8Array(THUMBNAIL_MIN_SOURCE_BYTES), "image/png")).toBeNull();
		expect(native.imageThumbnail).not.toHaveBeenCalled();
	});

	it("drops a derivative that isn't smaller than its source", async () => {
		const native = fakeModule({ bytes: Buffer.alloc(BIG.length + 1), mime: "image/jpeg" });
		const thumb = createNativeThumbnailer(async () => native);
		expect(await thumb(BIG, "image/png")).toBeNull();
	});

	it("fail-softs a throwing transform (undecodable source)", async () => {
		const native = fakeModule(new Error("decode failed"));
		const thumb = createNativeThumbnailer(async () => native);
		expect(await thumb(BIG, "image/png")).toBeNull();
	});

	it("fail-softs a missing addon, permanently and quietly (loads once)", async () => {
		const load = vi.fn(async () => {
			throw new Error("no .node for this platform");
		});
		const thumb = createNativeThumbnailer(load);
		expect(await thumb(BIG, "image/png")).toBeNull();
		expect(await thumb(BIG, "image/png")).toBeNull();
		expect(load).toHaveBeenCalledTimes(1);
	});
});

describe("createNativeThumbnailer against the real addon", () => {
	it("derives a real bounded JPEG from a real PNG (end-to-end through the binding)", async () => {
		// A genuine >32 KiB PNG built from noise so deflate can't collapse it.
		const { makePng } = await import("../../../../native-image/test/fixtures");
		const png = makePng({ width: 1400, height: 1000, noise: true });
		expect(png.length).toBeGreaterThan(THUMBNAIL_MIN_SOURCE_BYTES);
		const thumb = createNativeThumbnailer();
		const result = await thumb(new Uint8Array(png), "image/png");
		if (!result) throw new Error("expected a derivative from the real addon");
		expect(result.mime).toBe("image/jpeg");
		expect(result.bytes.length).toBeLessThan(png.length);
	});
});
