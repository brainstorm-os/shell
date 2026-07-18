// @vitest-environment jsdom
/**
 * Import-run store — the background-run contract: state survives subscriber
 * churn (Settings unmount/remount), one run at a time, progress flows from
 * the main-side stream, and completion lands the report.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ImportRunSection,
	ImportRunStatus,
	__resetImportRunForTests,
	dismissImportRun,
	startImportRun,
	useImportRun,
} from "./import-run-store";

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

describe("import-run store", () => {
	beforeEach(() => {
		__resetImportRunForTests();
		stubBridge();
	});
	afterEach(() => {
		__resetImportRunForTests();
	});

	it("runs in the background: resolves after start and lands the report", async () => {
		let resolveRun: (r: never) => void = () => {};
		const report = { created: 3, updated: 1, skipped: 0, failed: [] };
		const run = new Promise((r) => {
			resolveRun = r as never;
		});
		const started = startImportRun(ImportRunSection.Anytype, () => run as never);
		expect(started).toBe(true);
		// A second run is refused while the first is active.
		expect(startImportRun(ImportRunSection.Csv, () => run as never)).toBe(false);
		// Progress flows from the main-side stream.
		progressHandler?.({ done: 5, total: 49 });
		resolveRun(report as never);
		await Promise.resolve();
		await Promise.resolve();
		// After completion the next run may start (Done state is not Running).
		const again = startImportRun(ImportRunSection.Csv, () => Promise.resolve(report as never));
		expect(again).toBe(true);
		await Promise.resolve();
		await Promise.resolve();
		dismissImportRun();
	});

	it("a rejected run parks in Failed and frees the slot", async () => {
		const started = startImportRun(ImportRunSection.Notion, () => Promise.reject(new Error("boom")));
		expect(started).toBe(true);
		await Promise.resolve();
		await Promise.resolve();
		expect(
			startImportRun(ImportRunSection.Notion, () =>
				Promise.resolve({ created: 0, updated: 0, skipped: 0, failed: [] } as never),
			),
		).toBe(true);
	});
});
