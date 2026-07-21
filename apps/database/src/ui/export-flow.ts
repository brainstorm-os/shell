/**
 * List export flow (9.12.19) — serialize the active list's rows through the
 * `logic/list-export` keystone and save the bytes via the Files-host
 * `requestSaveBytes` (mirrors the Notes / Graph / Whiteboard export shape, and
 * the reverse of `import-flow`). Kept thin + injectable (a `SaveFileService` +
 * a `notify`) so it unit-tests against a stub host without a shell.
 */

import {
	SaveDispositionKind,
	type SaveFileService,
	requestSaveBytes,
	suggestedFilename,
	textToBytes,
} from "@brainstorm-os/sdk/export-file";
import type { EntityRow } from "@brainstorm-os/sdk/in-memory-entities";
import {
	type ExportColumn,
	ListExportFormat,
	type ListExportOptions,
	buildExportMatrix,
	extensionFor,
	serializeList,
} from "../logic/list-export";

export type ListExportInput = {
	files: SaveFileService;
	rows: readonly EntityRow[];
	columns: readonly ExportColumn[];
	titleOf: (row: EntityRow) => string;
	/** The list's display title — the save-dialog filename stem. */
	listTitle: string;
	format: ListExportFormat;
	/** Per-format serialization options from the export popover. */
	options?: ListExportOptions;
	notify: (message: string) => void;
};

const FILTER_NAME: Record<ListExportFormat, string> = {
	[ListExportFormat.Csv]: "CSV",
	[ListExportFormat.Json]: "JSON",
	[ListExportFormat.Markdown]: "Markdown",
};

export async function runListExport(input: ListExportInput): Promise<void> {
	const { files, rows, columns, titleOf, listTitle, format, options, notify } = input;
	const extension = extensionFor(format);
	const disposition = await requestSaveBytes(files, {
		suggestedName: suggestedFilename(listTitle, extension, { defaultStem: "list" }),
		filters: [{ name: FILTER_NAME[format], extensions: [extension] }],
		encode: () => {
			const matrix = buildExportMatrix(rows, columns, titleOf);
			return textToBytes(serializeList(format, matrix, options ?? {}));
		},
	});
	switch (disposition.kind) {
		case SaveDispositionKind.Saved:
			notify(
				`Exported ${rows.length} ${rows.length === 1 ? "row" : "rows"} to ${disposition.handle.displayName}`,
			);
			return;
		case SaveDispositionKind.Cancelled:
			return;
		case SaveDispositionKind.Failed:
			notify("Export failed");
			return;
	}
}
