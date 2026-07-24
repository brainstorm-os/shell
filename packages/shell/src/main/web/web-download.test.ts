import { DownloadFailReason } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	DOWNLOAD_FALLBACK_NAME,
	DOWNLOAD_FILENAME_MAX_LEN,
	DOWNLOAD_FILE_ENTITY_TYPE,
	MAX_DOWNLOAD_BYTES,
	downloadFileProperties,
	downloadSourceUrl,
	sanitizeDownloadFilename,
} from "./web-download";

describe("sanitizeDownloadFilename", () => {
	it("keeps an ordinary filename verbatim", () => {
		expect(sanitizeDownloadFilename("report.pdf")).toBe("report.pdf");
		expect(sanitizeDownloadFilename("My Photo (1).jpeg")).toBe("My Photo (1).jpeg");
	});

	it("reduces a path to its basename (POSIX + Windows) — no traversal survives", () => {
		expect(sanitizeDownloadFilename("../../etc/passwd")).toBe("passwd");
		expect(sanitizeDownloadFilename("/var/tmp/evil.sh")).toBe("evil.sh");
		expect(sanitizeDownloadFilename("C:\\Windows\\System32\\calc.exe")).toBe("calc.exe");
		expect(sanitizeDownloadFilename("a/b/c/nested.txt")).toBe("nested.txt");
	});

	it("strips residual path separators and NUL after basename extraction", () => {
		// A name that still smuggles a separator (encoded/odd form) never keeps it.
		expect(sanitizeDownloadFilename("we\\ird/na\u0000me.bin")).toBe("name.bin");
	});

	it("strips control, zero-width, and bidi-override characters", () => {
		expect(sanitizeDownloadFilename("in\u202evoice.exe")).toBe("invoice.exe");
		expect(sanitizeDownloadFilename("a\u200bb\u0007c.txt")).toBe("abc.txt");
	});

	it("collapses whitespace and trims", () => {
		expect(sanitizeDownloadFilename("  spaced   out .pdf ")).toBe("spaced out .pdf");
	});

	it("falls back for empty / dot-only inputs", () => {
		expect(sanitizeDownloadFilename("")).toBe(DOWNLOAD_FALLBACK_NAME);
		expect(sanitizeDownloadFilename("   ")).toBe(DOWNLOAD_FALLBACK_NAME);
		expect(sanitizeDownloadFilename(".")).toBe(DOWNLOAD_FALLBACK_NAME);
		expect(sanitizeDownloadFilename("..")).toBe(DOWNLOAD_FALLBACK_NAME);
		expect(sanitizeDownloadFilename("/")).toBe(DOWNLOAD_FALLBACK_NAME);
		expect(sanitizeDownloadFilename(null)).toBe(DOWNLOAD_FALLBACK_NAME);
		expect(sanitizeDownloadFilename(42)).toBe(DOWNLOAD_FALLBACK_NAME);
	});

	it("clamps an over-long name while preserving the extension", () => {
		const long = `${"a".repeat(5000)}.pdf`;
		const out = sanitizeDownloadFilename(long);
		expect(out.length).toBeLessThanOrEqual(DOWNLOAD_FILENAME_MAX_LEN);
		expect(out.endsWith(".pdf")).toBe(true);
	});

	it("drops a pathologically long extension when clamping", () => {
		const out = sanitizeDownloadFilename(`${"a".repeat(300)}.${"z".repeat(400)}`);
		expect(out.length).toBeLessThanOrEqual(DOWNLOAD_FILENAME_MAX_LEN);
	});
});

describe("downloadSourceUrl", () => {
	it("accepts and re-serializes http(s) URLs", () => {
		expect(downloadSourceUrl("https://example.com/a.pdf")).toBe("https://example.com/a.pdf");
		expect(downloadSourceUrl("http://host/x")).toBe("http://host/x");
	});

	it("rejects non-web schemes and garbage", () => {
		expect(downloadSourceUrl("file:///etc/passwd")).toBeNull();
		expect(downloadSourceUrl("javascript:alert(1)")).toBeNull();
		expect(downloadSourceUrl("data:text/html,x")).toBeNull();
		expect(downloadSourceUrl("not a url")).toBeNull();
		expect(downloadSourceUrl(null)).toBeNull();
	});

	it("rejects an over-long URL", () => {
		expect(downloadSourceUrl(`https://x.test/${"a".repeat(3000)}`)).toBeNull();
	});
});

describe("downloadFileProperties", () => {
	it("builds a File/v1 bag mirroring the shell import shape", () => {
		const props = downloadFileProperties({
			name: "report.pdf",
			mime: "application/pdf",
			size: 1234,
			hash: "abc123",
			assetId: "asset_9",
			sourceUrl: "https://example.com/report.pdf",
		});
		expect(props).toEqual({
			name: "report.pdf",
			mime: "application/pdf",
			size: 1234,
			hash: "abc123",
			assetId: "asset_9",
			attachment: "brainstorm://asset/asset_9",
			sourceUrl: "https://example.com/report.pdf",
		});
	});

	it("omits sourceUrl when it did not validate", () => {
		const props = downloadFileProperties({
			name: "x.bin",
			mime: "application/octet-stream",
			size: 1,
			hash: "h",
			assetId: "asset_1",
			sourceUrl: null,
		});
		expect("sourceUrl" in props).toBe(false);
		expect(props.attachment).toBe("brainstorm://asset/asset_1");
	});
});

describe("constants", () => {
	it("exposes the File/v1 wire type and a sane size ceiling", () => {
		expect(DOWNLOAD_FILE_ENTITY_TYPE).toBe("brainstorm/File/v1");
		expect(MAX_DOWNLOAD_BYTES).toBeGreaterThan(0);
	});

	it("has a fail-reason for each terminal outcome", () => {
		expect(DownloadFailReason.TooLarge).toBeDefined();
		expect(DownloadFailReason.Interrupted).toBeDefined();
		expect(DownloadFailReason.Empty).toBeDefined();
		expect(DownloadFailReason.WriteFailed).toBeDefined();
	});
});
