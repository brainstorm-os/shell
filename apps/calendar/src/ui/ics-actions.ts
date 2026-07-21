/**
 * ICS import / export actions (9.15.18) — the glue between the pure ICS
 * codec and the Files-host service. The two orchestrators take the files
 * service + callbacks as parameters (no runtime singleton reach), so they
 * unit-test against a stub. The React `IcsActionsButton` wires them to a
 * header ⋯ menu, enumerated only when `services.files` is bound.
 */

import {
	SaveDispositionKind,
	requestSaveBytes,
	suggestedFilename,
	textToBytes,
} from "@brainstorm-os/sdk/export-file";
import { t } from "../i18n/t";
import { parseCalendar, serializeCalendar } from "../logic/ics";
import type { CalendarFilesService } from "../storage/runtime";
import type { Event } from "../types/event";

const ICS_EXTENSION = "ics";

function icsFilters(): { name: string; extensions: string[] }[] {
	return [{ name: t("calendar.ics.filterName"), extensions: [ICS_EXTENSION] }];
}

/** Serialize `events` to an `.ics` file via the save dialog. No-op (with a
 *  notice) when there's nothing to export. */
export async function exportEventsToIcs(
	files: CalendarFilesService,
	events: readonly Event[],
	notify?: (message: string) => void,
): Promise<void> {
	if (events.length === 0) {
		notify?.(t("calendar.actions.exportEmpty"));
		return;
	}
	const result = await requestSaveBytes(files, {
		title: t("calendar.actions.saveDialogTitle"),
		suggestedName: suggestedFilename(t("calendar.app.title"), ICS_EXTENSION, {
			defaultStem: "calendar",
		}),
		filters: icsFilters(),
		encode: () => textToBytes(serializeCalendar(events)),
	});
	switch (result.kind) {
		case SaveDispositionKind.Saved:
			notify?.(t("calendar.actions.saved"));
			return;
		case SaveDispositionKind.Cancelled:
			return;
		case SaveDispositionKind.Failed:
			notify?.(t("calendar.actions.exportFailed"));
			console.warn("[calendar/ics] export failed", result.error);
			return;
	}
}

/** Open one or more `.ics` files, parse every VEVENT, and hand the merged
 *  list to `onImport` (which persists + refreshes). */
export async function importEventsFromIcs(
	files: CalendarFilesService,
	onImport: (events: Event[]) => Promise<void> | void,
	notify?: (message: string) => void,
): Promise<void> {
	try {
		const handles = await files.requestOpen({
			title: t("calendar.actions.openDialogTitle"),
			filters: icsFilters(),
			multiple: true,
		});
		if (!handles || handles.length === 0) return; // cancelled
		const decoder = new TextDecoder();
		const all: Event[] = [];
		for (const handle of handles) {
			const bytes = await files.read(handle);
			const { events } = parseCalendar(decoder.decode(bytes));
			all.push(...events);
		}
		if (all.length === 0) {
			notify?.(t("calendar.actions.importNone"));
			return;
		}
		await onImport(all);
		notify?.(t("calendar.actions.imported", { count: all.length }));
	} catch (error) {
		notify?.(t("calendar.actions.importFailed"));
		console.warn("[calendar/ics] import failed", error);
	}
}
