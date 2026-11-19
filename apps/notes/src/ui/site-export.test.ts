// @vitest-environment jsdom
import { bytesToB64 } from "@brainstorm-os/react-yjs";
import { SaveDispositionKind, type SaveFileService } from "@brainstorm-os/sdk/export-file";
import { IconName } from "@brainstorm-os/sdk/icon";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
	type SiteExportInput,
	SiteExportTone,
	buildSiteExportItems,
	fetchVaultAsset,
	openSiteExport,
	readThemeTokens,
	siteExportReport,
} from "./site-export";

const LABELS = {
	action: "Publish website…",
	dialogTitle: "Publish website",
	filterName: "Website (ZIP archive)",
	pages: "Pages",
	untitled: "Untitled",
	unpublished: "[unpublished page]",
	confirmTitle: "Publish “Handbook” as a website",
	subPagesLegend: "Sub-pages to include",
	formatLegend: "Format",
	confirmAction: "Publish",
	cancel: "Cancel",
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

/** A body holding one `page-ref` per id, in the encoding `loadDoc` returns. */
function bodyWithSubPages(ids: readonly string[]): string {
	const doc = new Y.Doc();
	const root = doc.get("root", Y.XmlText);
	for (const id of ids) {
		const ref = new Y.XmlElement("page-ref");
		root.insertEmbed(root.length, ref);
		ref.setAttribute("__type", "page-ref");
		ref.setAttribute("__entityId", id);
		ref.setAttribute("__label", id);
	}
	const encoded = bytesToB64(Y.encodeStateAsUpdate(doc));
	doc.destroy();
	return encoded;
}

const NOTES: Record<string, { title: string; parentId: string | null; subPages: string[] }> = {
	root: { title: "Handbook", parentId: null, subPages: ["a", "b", "planted"] },
	a: { title: "Onboarding", parentId: "root", subPages: [] },
	b: { title: "", parentId: "root", subPages: [] },
	planted: { title: "Private diary", parentId: null, subPages: [] },
};

function input(files: SaveFileService, extra: Partial<SiteExportInput> = {}): SiteExportInput {
	return {
		rootId: "root",
		title: "My: Hand/book",
		files,
		getPage: (id) => (Object.hasOwn(NOTES, id) ? (NOTES[id] ?? null) : null),
		pageAccess: async () => ({ scope: "solo", solo: true }),
		transport: {
			loadDoc: async (id) => ({ snapshotB64: bodyWithSubPages(NOTES[id]?.subPages ?? []) }),
			closeDoc: async () => {},
		},
		fetchAsset: async () => null,
		readTokens: () => ({ "--color-text-primary": "#123456" }),
		labels: LABELS,
		...extra,
	};
}

const decode = (data: Uint8Array) => new TextDecoder("latin1").decode(data);
const popover = () => document.querySelector<HTMLElement>('[data-testid="notes-publish-site"]');
const checkboxes = () => [
	...(popover()?.querySelectorAll<HTMLInputElement>("input[type=checkbox]") ?? []),
];
const button = (label: string) =>
	[...(popover()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
		(candidate) => candidate.textContent === label,
	);
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
	for (const el of document.querySelectorAll(".bs-popover, .bs-popover__backdrop")) el.remove();
	document.body.replaceChildren();
});

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

describe("openSiteExport — the pages are confirmed before anything is saved", () => {
	it("lists exactly the sub-pages that belong, all ticked, and asks nothing of the disk yet", async () => {
		const { files, requestSaveCalls } = stubFiles({ handleId: "h", displayName: "x.zip" });
		await openSiteExport(input(files));
		expect(popover()).not.toBeNull();
		expect(popover()?.textContent).toContain("Publish “Handbook” as a website");
		expect(popover()?.textContent).toContain("Sub-pages to include");
		const boxes = checkboxes();
		expect(boxes.map((box) => box.value)).toEqual(["a", "b"]);
		expect(boxes.every((box) => box.checked)).toBe(true);
		expect(popover()?.textContent).toContain("Onboarding");
		expect(popover()?.textContent).toContain("Untitled");
		expect(popover()?.textContent).not.toContain("Private diary");
		expect(requestSaveCalls).toEqual([]);
	});

	it("saves nothing when the confirmation is cancelled", async () => {
		const { files, requestSaveCalls, writes } = stubFiles({ handleId: "h", displayName: "x.zip" });
		const onResult = vi.fn();
		await openSiteExport(input(files, { onResult }));
		button("Cancel")?.click();
		await settle();
		expect(popover()).toBeNull();
		expect(requestSaveCalls).toEqual([]);
		expect(writes).toEqual([]);
		expect(onResult).not.toHaveBeenCalled();
	});

	it("publishes only the pages left ticked", async () => {
		const { files, requestSaveCalls, writes } = stubFiles({ handleId: "h", displayName: "x.zip" });
		const onResult = vi.fn();
		await openSiteExport(input(files, { onResult }));
		const unnamed = checkboxes().find((box) => box.value === "b");
		unnamed?.click();
		button("Publish")?.click();
		await vi.waitFor(() => expect(onResult).toHaveBeenCalled());
		expect(requestSaveCalls).toEqual([
			{
				title: "Publish website",
				suggestedName: "My_ Hand_book.zip",
				filters: [{ name: "Website (ZIP archive)", extensions: ["zip"] }],
			},
		]);
		const archive = decode(writes[0] ?? new Uint8Array());
		expect(archive.startsWith("PK\u0003\u0004")).toBe(true);
		expect(archive).toContain("index.html");
		expect(archive).toContain("onboarding.html");
		expect(archive).not.toContain("untitled.html");
		expect(archive).not.toContain("Private diary");
		expect(archive).toContain("--color-text-primary: #123456;");
		expect(onResult).toHaveBeenCalledWith(
			expect.objectContaining({ kind: SaveDispositionKind.Saved }),
			expect.objectContaining({ pageCount: 2, truncated: false, skippedAssets: 0 }),
		);
	});

	it("still confirms a page that has no sub-pages", async () => {
		const { files } = stubFiles(null);
		await openSiteExport(input(files, { rootId: "a" }));
		expect(popover()).not.toBeNull();
		expect(checkboxes()).toEqual([]);
		expect(button("Publish")?.disabled).toBe(false);
	});

	it("reports a page set that could not be worked out, without opening anything", async () => {
		const { files } = stubFiles(null);
		const onResult = vi.fn();
		await openSiteExport(input(files, { getPage: () => null, onResult }));
		expect(popover()).toBeNull();
		expect(onResult).toHaveBeenCalledWith(
			expect.objectContaining({ kind: SaveDispositionKind.Failed }),
			null,
		);
	});

	it("reports a save dialog cancelled after confirming, having written nothing", async () => {
		const { files, writes } = stubFiles(null);
		const onResult = vi.fn();
		await openSiteExport(input(files, { onResult }));
		button("Publish")?.click();
		await vi.waitFor(() => expect(onResult).toHaveBeenCalled());
		expect(writes).toEqual([]);
		expect(onResult).toHaveBeenCalledWith({ kind: SaveDispositionKind.Cancelled }, null);
	});
});

describe("siteExportReport", () => {
	const labels = {
		saved: (count: number, file: string) => `Published ${count} pages to ${file}.`,
		pagesTruncated: (count: number) => `Only the first ${count} pages were published.`,
		imagesSkipped: (count: number, limit: number) => `${count} images left out (${limit} MB).`,
		imagesWithheld: (count: number) => `${count} images on shared pages left out.`,
		failed: "The website could not be published.",
	};
	const saved = {
		kind: SaveDispositionKind.Saved,
		handle: { handleId: "h", displayName: "handbook.zip" },
	} as const;
	const stats = { pageCount: 3, truncated: false, skippedAssets: 0, withheldAssets: 0 };

	it("names the page count and the file on success", () => {
		expect(siteExportReport(saved, stats, labels)).toEqual({
			tone: SiteExportTone.Success,
			title: "Published 3 pages to handbook.zip.",
		});
	});

	it("says explicitly when pages or images were left out", () => {
		expect(siteExportReport(saved, { ...stats, pageCount: 200, truncated: true }, labels)).toEqual({
			tone: SiteExportTone.Warning,
			title: "Published 200 pages to handbook.zip.",
			detail: "Only the first 200 pages were published.",
		});
		expect(
			siteExportReport(
				saved,
				{ pageCount: 200, truncated: true, skippedAssets: 4, withheldAssets: 2 },
				labels,
			)?.detail,
		).toBe(
			"Only the first 200 pages were published. 4 images left out (100 MB). 2 images on shared pages left out.",
		);
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
