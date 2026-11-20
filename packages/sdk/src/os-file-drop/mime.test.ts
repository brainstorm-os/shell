import { describe, expect, it } from "vitest";
import { DEFAULT_MIME, mimeFromName } from "./mime";

describe("mimeFromName", () => {
	it("maps common extensions case-insensitively", () => {
		expect(mimeFromName("report.PDF")).toBe("application/pdf");
		expect(mimeFromName("photo.JPG")).toBe("image/jpeg");
		expect(mimeFromName("a.txt")).toBe("text/plain");
		expect(mimeFromName("a.md")).toBe("text/markdown");
		expect(mimeFromName("a.csv")).toBe("text/csv");
	});

	it("labels e-books, by the final extension of a compound name", () => {
		expect(mimeFromName("Dune.epub")).toBe("application/epub+zip");
		expect(mimeFromName("King_Bibliotechnaya-policiya.159046.fb2.epub")).toBe("application/epub+zip");
		expect(mimeFromName("King.159046.FB2")).toBe("application/x-fictionbook+xml");
		expect(mimeFromName("a.b.c.PDF")).toBe("application/pdf");
	});

	it("falls back to application/octet-stream for unknown extensions", () => {
		expect(mimeFromName("foo.weirdext")).toBe(DEFAULT_MIME);
	});

	it("returns the default when there is no extension", () => {
		expect(mimeFromName("README")).toBe(DEFAULT_MIME);
	});

	it("treats a dotfile (leading dot, nothing else) as extensionless", () => {
		expect(mimeFromName(".bashrc")).toBe(DEFAULT_MIME);
	});

	it("returns the default when the name ends with a dot", () => {
		expect(mimeFromName("foo.")).toBe(DEFAULT_MIME);
	});
});
