// @vitest-environment jsdom
/**
 * Transfer-run store — the background-run contract for BOTH kinds (IE-11):
 * state survives subscriber churn (Settings unmount/remount), one run at a
 * time across import and export, progress flows from the main-side stream,
 * and completion lands the report (import) or the written path (export).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastKind, dismissToast, getSnapshot as getToasts } from "../ui/toasts";
import {
	TransferRunKind,
	TransferRunSection,
	TransferRunStatus,
	__resetTransferRunForTests,
	dismissTransferRun,
	getTransferRunState,
	startExportRun,
	startImportRun,
} from "./transfer-run-store";

type ProgressHandler = (p: { done: number; total: number }) => void;

let progressHandler: ProgressHandler | null = null;

function stubBridge(): void {
	(window as unknown as { brainstorm: unknown }).brainstorm = {
		importExport: {
			onProgress: (h: ProgressHandler) => {
				progressHandler = h;
				return () => {
					progressHandler = null;
				};
			},
			cancel: vi.fn(),
		},
	};
}

const settle = async (): Promise<void> => {
	await Promise.resolve();
	await Promise.resolve();
};

describe("transfer-run store", () => {
	const clearToasts = (): void => {
		for (const toast of getToasts()) dismissToast(toast.id);
	};

	beforeEach(() => {
		__resetTransferRunForTests();
		stubBridge();
		clearToasts();
	});
	afterEach(() => {
		__resetTransferRunForTests();
		clearToasts();
		vi.restoreAllMocks();
	});

	it("runs an import in the background: resolves after start and lands the report", async () => {
		let resolveRun: (r: never) => void = () => {};
		const report = { created: 3, updated: 1, skipped: 0, failed: [] };
		const run = new Promise((r) => {
			resolveRun = r as never;
		});
		const started = startImportRun(TransferRunSection.Anytype, () => run as never);
		expect(started).toBe(true);
		expect(getTransferRunState().kind).toBe(TransferRunKind.Import);
		// A second run is refused while the first is active — either kind.
		expect(startImportRun(TransferRunSection.Csv, () => run as never)).toBe(false);
		expect(startExportRun(() => Promise.resolve(null))).toBe(false);
		// Progress flows from the main-side stream.
		progressHandler?.({ done: 5, total: 49 });
		expect(getTransferRunState().progress).toEqual({ done: 5, total: 49 });
		resolveRun(report as never);
		await settle();
		expect(getTransferRunState().status).toBe(TransferRunStatus.Done);
		expect(getTransferRunState().report).toEqual(report);
		// After completion the next run may start (Done state is not Running).
		const again = startImportRun(TransferRunSection.Csv, () => Promise.resolve(report as never));
		expect(again).toBe(true);
		await settle();
		dismissTransferRun();
	});

	it("a rejected import parks in Failed and frees the slot", async () => {
		const started = startImportRun(TransferRunSection.Notion, () =>
			Promise.reject(new Error("boom")),
		);
		expect(started).toBe(true);
		await settle();
		expect(getTransferRunState().status).toBe(TransferRunStatus.Failed);
		expect(getTransferRunState().error).toBe("boom");
		expect(
			startImportRun(TransferRunSection.Notion, () =>
				Promise.resolve({ created: 0, updated: 0, skipped: 0, failed: [] } as never),
			),
		).toBe(true);
	});

	it("runs an export in the background and lands the written path", async () => {
		let resolveRun: (r: { path: string } | null) => void = () => {};
		const run = new Promise<{ path: string } | null>((r) => {
			resolveRun = r;
		});
		const started = startExportRun(() => run);
		expect(started).toBe(true);
		const running = getTransferRunState();
		expect(running.status).toBe(TransferRunStatus.Running);
		expect(running.kind).toBe(TransferRunKind.Export);
		expect(running.section).toBe(TransferRunSection.Export);
		// An import may not start while the export runs.
		expect(startImportRun(TransferRunSection.Csv, () => Promise.reject(new Error("no")))).toBe(false);
		progressHandler?.({ done: 2, total: 10 });
		expect(getTransferRunState().progress).toEqual({ done: 2, total: 10 });
		resolveRun({ path: "/tmp/vault.bsbundle" });
		await settle();
		const done = getTransferRunState();
		expect(done.status).toBe(TransferRunStatus.Done);
		expect(done.exportPath).toBe("/tmp/vault.bsbundle");
		dismissTransferRun();
		expect(getTransferRunState().status).toBe(TransferRunStatus.Idle);
	});

	it("an export that returns null (dialog cancelled / stopped) goes back to Idle", async () => {
		expect(startExportRun(() => Promise.resolve(null))).toBe(true);
		await settle();
		expect(getTransferRunState().status).toBe(TransferRunStatus.Idle);
	});

	it("a rejected export parks in Failed", async () => {
		expect(startExportRun(() => Promise.reject(new Error("disk full")))).toBe(true);
		await settle();
		expect(getTransferRunState().status).toBe(TransferRunStatus.Failed);
		expect(getTransferRunState().kind).toBe(TransferRunKind.Export);
		expect(getTransferRunState().error).toBe("disk full");
	});

	it("announces outcomes beyond Settings: a toast when the window is focused", async () => {
		// A focused document routes the announce to the dashboard toast surface
		// (unfocused takes the OS notification instead).
		vi.spyOn(document, "hasFocus").mockReturnValue(true);

		expect(startExportRun(() => Promise.resolve({ path: "/tmp/v.bsbundle" }))).toBe(true);
		await settle();
		expect(getToasts().map((toast) => toast.kind)).toEqual([ToastKind.Success]);
		dismissTransferRun();
		clearToasts();

		expect(
			startImportRun(TransferRunSection.Anytype, () =>
				Promise.resolve({ created: 1, updated: 0, skipped: 0, failed: [] } as never),
			),
		).toBe(true);
		await settle();
		expect(getToasts().map((toast) => toast.kind)).toEqual([ToastKind.Success]);
		dismissTransferRun();
		clearToasts();

		expect(startExportRun(() => Promise.reject(new Error("disk full")))).toBe(true);
		await settle();
		const failed = getToasts();
		expect(failed.map((toast) => toast.kind)).toEqual([ToastKind.Error]);
		expect(failed[0]?.body).toBe("disk full");
	});
});
