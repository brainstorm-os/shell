// @vitest-environment jsdom
import { SaveDispositionKind, type SaveFileService } from "@brainstorm-os/sdk/export-file";
import { IconName } from "@brainstorm-os/sdk/icon";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type SiteExportInput,
	SiteExportTone,
	buildSiteExportItems,
	fetchVaultAsset,
	readThemeTokens,
	runSiteExport,
	siteExportReport,
} from "./site-export";

const LABELS = {
	action: "Publish website…",
	dialogTitle: "Publish website",
	filterName: "Website (ZIP archive)",
	pages: "Pages",
	untitled: "Untitled",
	unpublished: "[unpublished page]",
};

function stubFiles(target: { handleId: string; displayName: string } | null) {
	const requestSaveCalls: unknown[] = [];
	const writes: Uint8Array[] = [];
	const files: SaveFileService = {
		requestSave: async (opts) => {
			requestSaveCalls.push(opts);
			return target;
		},
		write: async (_handle, data) => {
			writes.push(data instanceof Uint8Array ? data : new Uint8Array(data));
		},
	};
	return { files, requestSaveCalls, writes };
}

function input(files: SaveFileService, extra: Partial<SiteExportInput> = {}): SiteExportInput {
	return {
		rootId: "root",
		title: "My: Hand/book",
		files,
		getPage: (id) => (id === "root" ? { title: "Handbook" } : null),
		transport: {
			loadDoc: async () => ({ snapshotB64: "" }),
			closeDoc: async () => {},
		},
		fetchAsset: async () => null,
		readTokens: () => ({ "--color-text-primary": "#123456" }),
		labels: LABELS,
		...extra,
	};
}

const decode = (data: Uint8Array) => new TextDecoder("latin1").decode(data);

describe("buildSiteExportItems", () => {
	it("is one read-only 'Publish website…' row", () => {
		const items = buildSiteExportItems(input(stubFiles(null).files));
		expect(items).toHaveLength(1);
		expect(items[0]?.id).toBe("publish-website");
		expect(items[0]?.label).toBe("Publish website…");
		expect(items[0]?.icon).toBe(IconName.OpenExternal);
		expect(items[0]?.writes).toBeUndefined();
	});
});

describe("runSiteExport", () => {
	it("asks for a .zip, then writes the site", async () => {
		const { files, requestSaveCalls, writes } = stubFiles({ handleId: "h", displayName: "x" });
		const onResult = vi.fn();
		await runSiteExport(input(files, { onResult }));
		expect(requestSaveCalls).toEqual([
			{
				title: "Publish website",
				suggestedName: "My_ Hand_book.zip",
				filters: [{ name: "Website (ZIP archive)", extensions: ["zip"] }],
			},
		]);
		expect(writes).toHaveLength(1);
		const archive = decode(writes[0] ?? new Uint8Array());
		expect(archive.startsWith("PK\u0003\u0004")).toBe(true);
		expect(archive).toContain("index.html");
		expect(archive).toContain("<h1>Handbook</h1>");
		expect(archive).toContain("--color-text-primary: #123456;");
		expect(onResult).toHaveBeenCalledWith(
			expect.objectContaining({ kind: SaveDispositionKind.Saved }),
			expect.objectContaining({ pageCount: 1, truncated: false, skippedAssets: 0 }),
		);
	});

	it("builds nothing when the save dialog is cancelled", async () => {
		const { files, writes } = stubFiles(null);
		const loadDoc = vi.fn(async () => ({ snapshotB64: "" }));
		const readTokens = vi.fn(() => ({}));
		const onResult = vi.fn();
		await runSiteExport(
			input(files, { transport: { loadDoc, closeDoc: async () => {} }, readTokens, onResult }),
		);
		expect(loadDoc).not.toHaveBeenCalled();
		expect(readTokens).not.toHaveBeenCalled();
		expect(writes).toEqual([]);
		expect(onResult).toHaveBeenCalledWith({ kind: SaveDispositionKind.Cancelled }, null);
	});

	it("reports a failed build instead of writing a partial file", async () => {
		const { files, writes } = stubFiles({ handleId: "h", displayName: "x" });
		const onResult = vi.fn();
		await runSiteExport(input(files, { getPage: () => null, onResult }));
		expect(writes).toEqual([]);
		expect(onResult).toHaveBeenCalledWith(
			expect.objectContaining({ kind: SaveDispositionKind.Failed }),
			null,
		);
	});
});

describe("siteExportReport", () => {
	const labels = {
		saved: (count: number, file: string) => `Published ${count} pages to ${file}.`,
		pagesTruncated: (count: number) => `Only the first ${count} pages were published.`,
		imagesSkipped: (count: number, limit: number) => `${count} images left out (${limit} MB).`,
		failed: "The website could not be published.",
	};
	const saved = {
		kind: SaveDispositionKind.Saved,
		handle: { handleId: "h", displayName: "handbook.zip" },
	} as const;
	const stats = { pageCount: 3, truncated: false, skippedAssets: 0 };

	it("names the page count and the file on success", () => {
		expect(siteExportReport(saved, stats, labels)).toEqual({
			tone: SiteExportTone.Success,
			title: "Published 3 pages to handbook.zip.",
		});
	});

	it("says explicitly when pages or images were left out", () => {
		expect(
			siteExportReport(saved, { pageCount: 200, truncated: true, skippedAssets: 0 }, labels),
		).toEqual({
			tone: SiteExportTone.Warning,
			title: "Published 200 pages to handbook.zip.",
			detail: "Only the first 200 pages were published.",
		});
		expect(
			siteExportReport(saved, { pageCount: 200, truncated: true, skippedAssets: 4 }, labels)?.detail,
		).toBe("Only the first 200 pages were published. 4 images left out (100 MB).");
	});

	it("never shows the error behind a failure", () => {
		const error = new Error("ENOENT /Users/me/vault/secret-entity-id");
		const report = siteExportReport({ kind: SaveDispositionKind.Failed, error }, null, labels);
		expect(report).toEqual({
			tone: SiteExportTone.Error,
			title: "The website could not be published.",
		});
		expect(JSON.stringify(report)).not.toMatch(/ENOENT|secret/);
	});

	it("says nothing when the dialog was cancelled", () => {
		expect(siteExportReport({ kind: SaveDispositionKind.Cancelled }, null, labels)).toBeNull();
	});
});

describe("readThemeTokens", () => {
	it("keeps the design tokens set on the root and nothing else", () => {
		const el = document.createElement("div");
		el.style.setProperty("--color-text-primary", " #101010 ");
		el.style.setProperty("--space-4", "16px");
		el.style.setProperty("--radius-md", "8px");
		el.style.setProperty("--app-wallpaper-image", 'url("file:///Users/me/secret.png")');
		el.style.setProperty("--window-inset-top", "28px");
		el.style.setProperty("color", "red");
		expect(readThemeTokens(el.style)).toEqual({
			"--color-text-primary": "#101010",
			"--space-4": "16px",
			"--radius-md": "8px",
		});
	});
});

describe("fetchVaultAsset", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("returns the bytes and the served MIME without its parameters", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(new Uint8Array([1, 2, 3]), {
					headers: { "content-type": "image/png; charset=binary" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const asset = await fetchVaultAsset("a b/../c");
		expect(fetchMock).toHaveBeenCalledWith("brainstorm://asset/a%20b%2F..%2Fc");
		expect(asset?.mime).toBe("image/png");
		expect([...(asset?.bytes ?? [])]).toEqual([1, 2, 3]);
	});

	it("returns null for a missing or empty asset", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 404 })),
		);
		expect(await fetchVaultAsset("x")).toBeNull();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(new Uint8Array(), { headers: { "content-type": "image/png" } })),
		);
		expect(await fetchVaultAsset("x")).toBeNull();
	});
});
