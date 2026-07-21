// @vitest-environment jsdom
import type { SaveFileService } from "@brainstorm-os/sdk/export-file";
import type { SerializedEditorState } from "lexical";
import { afterEach, describe, expect, it } from "vitest";
import { NoteExportFormat, buildNoteExportItems, runNoteExport } from "./note-export";

const STATE = {
	root: {
		type: "root",
		children: [
			{
				type: "paragraph",
				children: [{ type: "text", text: "Hello export", format: 0 }],
			},
		],
	},
} as unknown as SerializedEditorState;

const FILTER_BY_FORMAT: Record<NoteExportFormat, string> = {
	[NoteExportFormat.Markdown]: "Markdown",
	[NoteExportFormat.Html]: "HTML",
	[NoteExportFormat.Pdf]: "PDF",
};
const LABELS = {
	filterName: (f: NoteExportFormat) => FILTER_BY_FORMAT[f],
	dialogTitle: "Export note",
	exportAction: "Export…",
	formatLegend: "Format",
	cancel: "Cancel",
};

function stubFiles() {
	const requestSaveCalls: unknown[] = [];
	const writes: Uint8Array[] = [];
	const files: SaveFileService = {
		requestSave: async (opts) => {
			requestSaveCalls.push(opts);
			return { handleId: "h1", displayName: "out" };
		},
		write: async (_handle, data) => {
			writes.push(data instanceof Uint8Array ? data : new Uint8Array(data));
		},
	};
	return { files, requestSaveCalls, writes };
}

const decode = (b: Uint8Array) => new TextDecoder().decode(b);

describe("buildNoteExportItems", () => {
	afterEach(() => {
		for (const el of document.querySelectorAll(".bs-popover")) el.remove();
	});

	it("is a single 'Export…' object-menu row (opens the shared popover)", () => {
		const { files } = stubFiles();
		const items = buildNoteExportItems({ files, title: "T", getState: () => STATE, labels: LABELS });
		expect(items).toHaveLength(1);
		expect(items[0]?.id).toBe("export");
		expect(items[0]?.label).toBe("Export…");
	});

	it("run() opens the export popover offering Markdown + HTML formats", () => {
		const { files } = stubFiles();
		const [item] = buildNoteExportItems({ files, title: "T", getState: () => STATE, labels: LABELS });
		item?.run();
		const popover = document.querySelector(".bs-popover");
		expect(popover).not.toBeNull();
		const text = popover?.textContent ?? "";
		expect(text).toContain("Markdown");
		expect(text).toContain("HTML");
		expect(text).not.toContain("PDF");
	});

	it("offers the PDF format only when an exportPdf renderer is supplied", () => {
		const { files } = stubFiles();
		const [item] = buildNoteExportItems({
			files,
			title: "T",
			getState: () => STATE,
			labels: LABELS,
			exportPdf: async () => new Uint8Array([1]),
		});
		item?.run();
		expect(document.querySelector(".bs-popover")?.textContent ?? "").toContain("PDF");
	});
});

describe("runNoteExport (print-chord path)", () => {
	it("PDF prints the live note's HTML and saves `.pdf` bytes", async () => {
		const { files, requestSaveCalls, writes } = stubFiles();
		let renderedHtml = "";
		await runNoteExport(NoteExportFormat.Pdf, {
			files,
			title: "Report",
			getState: () => STATE,
			labels: LABELS,
			exportPdf: async (html) => {
				renderedHtml = html;
				return new Uint8Array([5, 5]);
			},
		});
		expect(renderedHtml).toContain("Hello export");
		expect(requestSaveCalls[0]).toMatchObject({ suggestedName: "Report.pdf" });
		expect(Array.from(writes[0] as Uint8Array)).toEqual([5, 5]);
	});

	it("is a no-op for PDF when no exportPdf renderer is supplied", async () => {
		const { files, requestSaveCalls } = stubFiles();
		await runNoteExport(NoteExportFormat.Pdf, {
			files,
			title: "T",
			getState: () => STATE,
			labels: LABELS,
		});
		expect(requestSaveCalls).toHaveLength(0);
	});

	it("is a no-op when no editor state is available", async () => {
		const { files, requestSaveCalls } = stubFiles();
		await runNoteExport(NoteExportFormat.Markdown, {
			files,
			title: "T",
			getState: () => null,
			labels: LABELS,
		});
		expect(requestSaveCalls).toHaveLength(0);
	});
});
