import { DownloadFailReason, WebViewEventKind } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import {
	DownloadStatus,
	MAX_DOWNLOAD_NOTICES,
	dismissDownload,
	reduceDownloads,
} from "./downloads";

const started = (downloadId: string, filename: string) =>
	({ kind: WebViewEventKind.DownloadStarted, tabId: "t", downloadId, filename }) as const;
const completed = (downloadId: string, filename: string, fileId: string) =>
	({ kind: WebViewEventKind.DownloadCompleted, tabId: "t", downloadId, filename, fileId }) as const;
const failed = (downloadId: string, reason: DownloadFailReason) =>
	({
		kind: WebViewEventKind.DownloadFailed,
		tabId: "t",
		downloadId,
		filename: "x.bin",
		reason,
	}) as const;

describe("reduceDownloads", () => {
	it("adds a downloading notice on start", () => {
		const list = reduceDownloads([], started("d1", "a.pdf"), 1);
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({
			downloadId: "d1",
			filename: "a.pdf",
			status: DownloadStatus.Downloading,
		});
	});

	it("transitions a notice to completed with the stored name + file id", () => {
		let list = reduceDownloads([], started("d1", "a.pdf"), 1);
		list = reduceDownloads(list, completed("d1", "a.pdf", "ent_9"), 2);
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({
			downloadId: "d1",
			status: DownloadStatus.Completed,
			fileId: "ent_9",
		});
	});

	it("transitions a notice to failed with a reason", () => {
		let list = reduceDownloads([], started("d1", "a.pdf"), 1);
		list = reduceDownloads(list, failed("d1", DownloadFailReason.TooLarge), 2);
		expect(list[0]).toMatchObject({
			status: DownloadStatus.Failed,
			reason: DownloadFailReason.TooLarge,
		});
	});

	it("keeps the newest notice first", () => {
		let list = reduceDownloads([], started("d1", "a.pdf"), 1);
		list = reduceDownloads(list, started("d2", "b.pdf"), 2);
		expect(list.map((n) => n.downloadId)).toEqual(["d2", "d1"]);
	});

	it("adds a completed notice even if the start was missed", () => {
		const list = reduceDownloads([], completed("d9", "late.zip", "ent_1"), 5);
		expect(list[0]).toMatchObject({ downloadId: "d9", status: DownloadStatus.Completed });
	});

	it("caps the notice list", () => {
		let list: ReturnType<typeof reduceDownloads> = [];
		for (let i = 0; i < MAX_DOWNLOAD_NOTICES + 3; i += 1) {
			list = reduceDownloads(list, started(`d${i}`, `f${i}.bin`), i);
		}
		expect(list).toHaveLength(MAX_DOWNLOAD_NOTICES);
	});

	it("returns the same reference for a non-download event", () => {
		const list = reduceDownloads([], started("d1", "a.pdf"), 1);
		const next = reduceDownloads(list, { kind: WebViewEventKind.Closed, tabId: "t" }, 2);
		expect(next).toBe(list);
	});
});

describe("dismissDownload", () => {
	it("drops the matching notice", () => {
		let list = reduceDownloads([], started("d1", "a.pdf"), 1);
		list = reduceDownloads(list, started("d2", "b.pdf"), 2);
		const next = dismissDownload(list, "d1");
		expect(next.map((n) => n.downloadId)).toEqual(["d2"]);
	});

	it("returns the same reference when nothing matches", () => {
		const list = reduceDownloads([], started("d1", "a.pdf"), 1);
		expect(dismissDownload(list, "nope")).toBe(list);
	});
});
