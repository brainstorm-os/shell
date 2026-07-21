/**
 * Tasks "Export…" object-menu rows (IE-8) — the generic entity-export
 * affordance wired to Tasks' runtime. Delegates entirely to the shared
 * `@brainstorm-os/sdk/entity-export` primitive (serialise via
 * `export.serializeEntities` → save via the Files host), supplying Tasks'
 * `t()` labels. A single task header exports that task; a project header
 * exports all the project's tasks (the spreadsheet/backup case).
 *
 * Returns `[]` when the runtime lacks the export or files service (preview /
 * older shells) or there is nothing to export, so the row is simply absent
 * rather than dead.
 */

import type { ExportTextFormat } from "@brainstorm-os/sdk-types";
import { type EntityExportInput, buildEntityExportItems } from "@brainstorm-os/sdk/entity-export";
import type { ObjectMenuExtraItem } from "@brainstorm-os/sdk/object-menu";
import { t } from "../i18n/t";
import type { TasksBrainstorm } from "../storage/runtime";

function exportLabels(dialogTitle: string): EntityExportInput["labels"] {
	const formatNames: Record<ExportTextFormat, string> = {
		markdown: t("tasks.export.markdown"),
		csv: t("tasks.export.csv"),
		json: t("tasks.export.json"),
	};
	return {
		filterName: (format) => formatNames[format],
		dialogTitle,
		exportAction: t("tasks.export.action"),
		formatLegend: t("tasks.export.formatLegend"),
		cancel: t("tasks.export.cancel"),
	};
}

export type TaskExportInput = {
	runtime: TasksBrainstorm | null;
	entityIds: readonly string[];
	/** Save-dialog default filename stem (the task / project name). */
	name?: string | null;
	/** Use the plural dialog title (a project's task set vs a single task). */
	plural?: boolean;
};

/** Build the "Export…" extra items for a Tasks object menu, or `[]` when the
 *  export/files services aren't available or there's nothing to export. */
export function buildTaskExportItems(input: TaskExportInput): ObjectMenuExtraItem[] {
	const exportSvc = input.runtime?.services.export;
	const filesSvc = input.runtime?.services.files;
	if (!exportSvc || !filesSvc) return [];
	return buildEntityExportItems({
		entityIds: input.entityIds,
		name: input.name ?? null,
		serialize: (serializeInput) => exportSvc.serializeEntities(serializeInput),
		files: filesSvc,
		labels: exportLabels(input.plural ? t("tasks.export.projectTitle") : t("tasks.export.title")),
	});
}
