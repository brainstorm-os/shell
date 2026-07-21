/**
 * `buildEntityExportItems` / `runEntityExport` — the generic "Export…" object-
 * menu affordance for **any** entity (IE-8). Serialises an entity's properties
 * to Markdown / CSV / JSON through the `export.serializeEntities` host service
 * and saves the bytes via the shared Files-host flow (`requestSaveBytes`) — the
 * same export chrome (popover + save dialog) Notes / Graph / Whiteboard use,
 * but content-agnostic: it works off entity *ids*, not an app-specific document
 * model, so any app whose objects are vault entities (Database, Contacts,
 * Tasks, …) drops it into its object menu with no per-app export code.
 *
 * The `serialize` port is injected (`rt.services.export.serializeEntities`) so
 * this stays a pure builder, unit-testable against stubs without a shell — the
 * same split `note-export.ts` uses for its editor-state encoders. Serialisation
 * is lazy: it fires only after the user commits a save location, never on
 * cancel. Per-entity `entities.read:<type>` is enforced by the host handler
 * against the workflow/app caps; an entity the app can't read serialises to
 * nothing rather than leaking.
 */

import type { ExportTextFormat } from "@brainstorm-os/sdk-types";
import {
	type SaveDisposition,
	type SaveFileService,
	requestSaveBytes,
	suggestedFilename,
	textToBytes,
} from "../export-file";
import { openExportPopover } from "../export-popover";
import { IconName } from "../icon";
import type { ObjectMenuExtraItem } from "../object-menu";

/** Serialises the given entities to text — `rt.services.export.serializeEntities`. */
export type EntitySerializer = (input: {
	ids: readonly string[];
	format: ExportTextFormat;
}) => Promise<string>;

/** File extension per format (Markdown is `.md`, not `.markdown`). */
const FORMAT_EXTENSION: Record<ExportTextFormat, string> = {
	json: "json",
	csv: "csv",
	markdown: "md",
};

/** The default format set, in menu order. */
export const ENTITY_EXPORT_FORMATS: readonly ExportTextFormat[] = ["markdown", "csv", "json"];

export type EntityExportLabels = {
	/** Per-format name (e.g. `Markdown`) — the popover radio + save-dialog filter. */
	filterName: (format: ExportTextFormat) => string;
	/** Save-dialog window title + export-popover title. */
	dialogTitle: string;
	/** The "Export…" menu row + popover action button. */
	exportAction: string;
	/** Legend over the popover's format radiogroup (e.g. "Format"). */
	formatLegend: string;
	/** Popover Cancel button. */
	cancel: string;
};

export type EntityExportInput = {
	/** The entity ids to serialise — one entity, or a selection / collection. */
	entityIds: readonly string[];
	/** Save-dialog default filename stem (the entity / collection name). */
	name?: string | null;
	serialize: EntitySerializer;
	files: SaveFileService;
	labels: EntityExportLabels;
	/** Format subset to offer; defaults to {@link ENTITY_EXPORT_FORMATS}. */
	formats?: readonly ExportTextFormat[];
	/** Surface the terminal disposition (toast / status). Optional. */
	onResult?: (format: ExportTextFormat, disposition: SaveDisposition) => void;
};

/** Run one export format: prompt for a save location, then serialise + write.
 *  No-op when there are no entities to export. Serialisation is deferred into
 *  the `encode` thunk so a cancelled save never hits the host service. */
export async function runEntityExport(
	format: ExportTextFormat,
	input: EntityExportInput,
): Promise<void> {
	if (input.entityIds.length === 0) return;
	const extension = FORMAT_EXTENSION[format];
	const disposition = await requestSaveBytes(input.files, {
		title: input.labels.dialogTitle,
		suggestedName: suggestedFilename(input.name, extension, { defaultStem: "export" }),
		filters: [{ name: input.labels.filterName(format), extensions: [extension] }],
		encode: async () => textToBytes(await input.serialize({ ids: input.entityIds, format })),
	});
	input.onResult?.(format, disposition);
}

/** A single "Export…" object-menu row opening the shared export popover — one
 *  format picker (Markdown / CSV / JSON), the same chrome every app uses.
 *  Returns `[]` when there is nothing to export so the row never shows empty. */
export function buildEntityExportItems(input: EntityExportInput): ObjectMenuExtraItem[] {
	if (input.entityIds.length === 0) return [];
	const formats = input.formats ?? ENTITY_EXPORT_FORMATS;
	return [
		{
			id: "export",
			label: input.labels.exportAction,
			icon: IconName.Download,
			run: () => {
				openExportPopover({
					spec: {
						formats: formats.map((format) => ({
							id: format,
							label: input.labels.filterName(format),
						})),
					},
					labels: {
						title: input.labels.dialogTitle,
						formatLegend: input.labels.formatLegend,
						exportAction: input.labels.exportAction,
						cancel: input.labels.cancel,
					},
					onExport: ({ formatId }) => runEntityExport(formatId as ExportTextFormat, input),
				});
			},
		},
	];
}
