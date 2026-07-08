// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// F-245 regression. pdf.js v6 REMOVED `PDFDocumentProxy.destroy()` — the
// Promise teardown now lives only on the loading TASK. Books/Preview call
// `doc.destroy().catch(...)`, so a raw proxy (no destroy) threw
// "doc.destroy is not a function" into the error boundary on PDF close.
// Simulate exactly that shape: the resolved proxy has NO destroy; only the
// task does. `openPdfDocument` must paper over it.
const taskDestroy = vi.fn(() => Promise.resolve());
const rawProxyWithoutDestroy = { numPages: 3 };

vi.mock("pdfjs-dist", () => ({
	// workerSrc set so loadPdfEngine skips `new Worker(...)` (absent under jsdom).
	GlobalWorkerOptions: { workerSrc: "stub", workerPort: null },
	getDocument: vi.fn(() => ({
		promise: Promise.resolve(rawProxyWithoutDestroy),
		destroy: taskDestroy,
	})),
}));

import { openPdfDocument } from "./index";

describe("openPdfDocument teardown (F-245)", () => {
	it("exposes a Promise-returning destroy even when the pdfjs proxy lacks one", async () => {
		const doc = await openPdfDocument(new Uint8Array([1, 2, 3]));
		// The raw proxy has no destroy; the engine must have installed one.
		expect(typeof doc.destroy).toBe("function");
		const result = doc.destroy();
		expect(result).toBeInstanceOf(Promise);
		await expect(result).resolves.toBeUndefined();
		// …and it delegates to the loading task's real teardown.
		expect(taskDestroy).toHaveBeenCalledTimes(1);
	});
});
