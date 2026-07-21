/**
 * `buildNoteExportItems` — the Markdown / HTML / PDF "Export…" entries
 * spliced into a note's shared object menu (B11.12). Each item serialises the
 * open note's live `SerializedEditorState` through the `@brainstorm-os/editor`
 * keystones (`serializedStateToMarkdown` / `serializedStateToHtml`) and saves
 * the bytes via the Files-host flow (`requestSaveBytes`), exactly as Graph /
 * Whiteboard do for their exports.
 *
 * PDF (the third format) renders the same hardened HTML through the privileged
 * `export.printToPdf` shell service (sandboxed, script-disabled,
 * network-blocked offscreen window) and saves the returned bytes. It's only
 * offered when an `exportPdf` renderer is supplied (i.e. the runtime exposes
 * `services.export`) — `encode` is lazy, so the PDF render fires only after
 * the user commits a save location, not on cancel.
 *
 * Kept out of the React tree (a pure builder taking a state getter + the
 * Files surface) so it unit-tests against stubs without a shell.
 */

import { serializedStateToHtml, serializedStateToMarkdown } from "@brainstorm-os/editor";
import {
	type SaveDisposition,
	type SaveFileService,
	requestSaveBytes,
	suggestedFilename,
	textToBytes,
} from "@brainstorm-os/sdk/export-file";
import { openExportPopover } from "@brainstorm-os/sdk/export-popover";
import { IconName } from "@brainstorm-os/sdk/icon";
import type { ObjectMenuExtraItem } from "@brainstorm-os/sdk/object-menu";
import type { SerializedEditorState } from "lexical";

export enum NoteExportFormat {
	Markdown = "markdown",
	Html = "html",
	Pdf = "pdf",
}

type FormatSpec = {
	id: NoteExportFormat;
	extension: string;
	encode: (state: SerializedEditorState) => Uint8Array | Promise<Uint8Array>;
};

export type NoteExportLabels = {
	/** Per-format name, e.g. `Markdown` — the export-popover format radio AND
	 *  the save-dialog filter name. */
	filterName: (format: NoteExportFormat) => string;
	/** Save-dialog window title + the export popover title. */
	dialogTitle: string;
	/** Export-popover chrome: the "Export…" menu row + popover action button. */
	exportAction: string;
	/** Legend over the popover's format radiogroup, e.g. "Format". */
	formatLegend: string;
	/** Popover Cancel button. */
	cancel: string;
};

export type NoteExportInput = {
	/** Reads the note's current editor state at click time. Returns null when
	 *  no editor is mounted (menu opened before a note hydrated) — the row is
	 *  a no-op rather than exporting an empty file. */
	getState: () => SerializedEditorState | null;
	files: SaveFileService;
	title: string;
	labels: NoteExportLabels;
	/** Renders self-contained HTML to PDF bytes (`services.export.printToPdf`).
	 *  When omitted, the PDF row is not offered. */
	exportPdf?: (html: string) => Promise<Uint8Array>;
	/** Surface the terminal disposition (toast / status). Optional. */
	onResult?: (format: NoteExportFormat, disposition: SaveDisposition) => void;
};

/** The export formats available for the given runtime. PDF is present only
 *  when an `exportPdf` renderer is supplied (i.e. `services.export` exists). */
function exportFormatSpecs(exportPdf?: (html: string) => Promise<Uint8Array>): FormatSpec[] {
	const formats: FormatSpec[] = [
		{
			id: NoteExportFormat.Markdown,
			extension: "md",
			encode: (state) => textToBytes(serializedStateToMarkdown(state)),
		},
		{
			id: NoteExportFormat.Html,
			extension: "html",
			encode: (state) => textToBytes(serializedStateToHtml(state)),
		},
	];
	if (exportPdf) {
		formats.push({
			id: NoteExportFormat.Pdf,
			extension: "pdf",
			encode: (state) => exportPdf(serializedStateToHtml(state)),
		});
	}
	return formats;
}

/** Run a single export format: read the live state, prompt for a save
 *  location, and write the encoded bytes. Shared by the object-menu rows and
 *  the print chord (B11.6) so both paths produce identical files. No-op when
 *  no editor is mounted, or when the requested format isn't available (e.g.
 *  PDF without `services.export`). */
export async function runNoteExport(
	format: NoteExportFormat,
	input: NoteExportInput,
): Promise<void> {
	const spec = exportFormatSpecs(input.exportPdf).find((f) => f.id === format);
	if (!spec) return;
	const state = input.getState();
	if (!state) return;
	const disposition = await requestSaveBytes(input.files, {
		title: input.labels.dialogTitle,
		suggestedName: suggestedFilename(input.title, spec.extension),
		filters: [{ name: input.labels.filterName(format), extensions: [spec.extension] }],
		encode: () => spec.encode(state),
	});
	input.onResult?.(format, disposition);
}

/** A single "Export…" object-menu row that opens the shared export popover —
 *  one format picker for Markdown / HTML / PDF, the same chrome every app uses
 *  (Database, Graph, …). Picking a format runs the same {@link runNoteExport}
 *  the print chord uses, so the bytes are identical regardless of entry point. */
export function buildNoteExportItems(input: NoteExportInput): ObjectMenuExtraItem[] {
	const specs = exportFormatSpecs(input.exportPdf);
	return [
		{
			id: "export",
			label: input.labels.exportAction,
			icon: IconName.Download,
			run: () => {
				openExportPopover({
					spec: {
						formats: specs.map((s) => ({ id: s.id, label: input.labels.filterName(s.id) })),
					},
					labels: {
						title: input.labels.dialogTitle,
						formatLegend: input.labels.formatLegend,
						exportAction: input.labels.exportAction,
						cancel: input.labels.cancel,
					},
					onExport: ({ formatId }) => runNoteExport(formatId as NoteExportFormat, input),
				});
			},
		},
	];
}
