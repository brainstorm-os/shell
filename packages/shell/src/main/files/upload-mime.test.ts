import { describe, expect, it } from "vitest";
import {
	UPLOAD_FALLBACK_MIME,
	extensionForMime,
	isPreviewableImageMime,
	servedMimeForName,
} from "./upload-mime";

describe("servedMimeForName", () => {
	it("maps preview-safe extensions case-insensitively", () => {
		expect(servedMimeForName("photo.png")).toBe("image/png");
		expect(servedMimeForName("PHOTO.JPG")).toBe("image/jpeg");
		expect(servedMimeForName("clip.WebM")).toBe("video/webm");
		expect(servedMimeForName("paper.pdf")).toBe("application/pdf");
		expect(servedMimeForName("notes.md")).toBe("text/plain");
	});

	it("collapses active content to octet-stream — svg/html/xml/js never get a renderable Content-Type", () => {
		for (const name of ["vector.svg", "page.html", "page.htm", "feed.xml", "script.js"]) {
			expect(servedMimeForName(name)).toBe(UPLOAD_FALLBACK_MIME);
		}
	});

	it("falls back on unknown, missing, trailing-dot, and hidden-file names", () => {
		expect(servedMimeForName("archive.xyz")).toBe(UPLOAD_FALLBACK_MIME);
		expect(servedMimeForName("README")).toBe(UPLOAD_FALLBACK_MIME);
		expect(servedMimeForName("weird.")).toBe(UPLOAD_FALLBACK_MIME);
		expect(servedMimeForName(".bashrc")).toBe(UPLOAD_FALLBACK_MIME);
	});
});

describe("extensionForMime", () => {
	it("maps preview-safe mimes to a canonical extension", () => {
		expect(extensionForMime("image/png")).toBe("png");
		expect(extensionForMime("image/jpeg")).toBe("jpg");
		expect(extensionForMime("application/pdf")).toBe("pdf");
	});

	it("returns null for unsafe, unknown, and missing mimes", () => {
		expect(extensionForMime("image/svg+xml")).toBeNull();
		expect(extensionForMime("text/html")).toBeNull();
		expect(extensionForMime(UPLOAD_FALLBACK_MIME)).toBeNull();
		expect(extensionForMime(null)).toBeNull();
	});
});

describe("isPreviewableImageMime", () => {
	it("accepts image/* and rejects the rest", () => {
		expect(isPreviewableImageMime("image/png")).toBe(true);
		expect(isPreviewableImageMime("application/pdf")).toBe(false);
		expect(isPreviewableImageMime(UPLOAD_FALLBACK_MIME)).toBe(false);
	});
});
