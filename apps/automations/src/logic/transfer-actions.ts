/**
 * 11b.16 — Export / Import orchestrators over the pure transfer codec
 * (`logic/transfer.ts`). These are the glue between the codec and the
 * runtime services (entities + Files host + clipboard); they take every
 * dependency as a parameter (no runtime-singleton reach) so they unit-test
 * against stubs, mirroring `apps/calendar`'s `ics-actions.ts`.
 *
 * Export packs ONE workflow + its bound trigger; Import file-picks → parses
 * (fail-closed) → mints a disabled trigger+workflow pair with the capability
 * sheet recomputed from the steps. The disposition enums let the caller
 * surface the right status string without branching on truthy / instanceof.
 */

import {
	SaveDispositionKind,
	requestSaveBytes,
	suggestedFilename,
	textToBytes,
} from "@brainstorm-os/sdk/export-file";
import { loadTrigger, persistImportedAutomation } from "../storage/automation-repository";
import type { LoadedWorkflow } from "../storage/automation-repository";
import type { EntitiesService, FilesService } from "../storage/runtime";
import {
	type AutomationBundle,
	exportAutomation,
	importAutomation,
	parseAutomationBundle,
	resolveImportName,
	serializeAutomationBundle,
} from "./transfer";

export const BUNDLE_EXTENSION = "json";

/** Terminal outcome of the export-to-file flow, discriminated so the caller
 *  picks one status string. `MissingTrigger` is the import-time analogue of
 *  a dangling binding — the workflow's `triggerId` resolved to nothing. */
export enum ExportOutcome {
	Saved = "saved",
	Copied = "copied",
	Cancelled = "cancelled",
	MissingTrigger = "missing-trigger",
	Failed = "failed",
}

/** Terminal outcome of the import flow. `Invalid` carries the structured
 *  parse issues so the caller can show why a bundle was rejected. */
export enum ImportOutcome {
	Imported = "imported",
	Cancelled = "cancelled",
	Invalid = "invalid",
	Failed = "failed",
}

export type ExportResult = { outcome: ExportOutcome };

export type ImportResult =
	| { outcome: ImportOutcome.Imported; name: string }
	| { outcome: ImportOutcome.Invalid; issues: string[] }
	| { outcome: ImportOutcome.Cancelled }
	| { outcome: ImportOutcome.Failed };

function bundleFilters(name: string): { name: string; extensions: string[] }[] {
	return [{ name, extensions: [BUNDLE_EXTENSION] }];
}

/** Pack `loaded` + its trigger into a serialized bundle, or null when the
 *  trigger binding can't be resolved (a dangling workflow). */
async function buildBundleText(
	entities: EntitiesService | null | undefined,
	loaded: LoadedWorkflow,
): Promise<{ bundle: AutomationBundle; text: string } | null> {
	const trigger = await loadTrigger(entities, loaded.def.triggerId);
	if (!trigger) return null;
	const bundle = exportAutomation(loaded.def, trigger);
	return { bundle, text: serializeAutomationBundle(bundle) };
}

/** Export a workflow to a `.json` bundle file via the Files-host save flow. */
export async function exportWorkflowToFile(
	entities: EntitiesService | null | undefined,
	files: FilesService,
	loaded: LoadedWorkflow,
	labels: { dialogTitle: string; filterName: string },
): Promise<ExportResult> {
	const built = await buildBundleText(entities, loaded);
	if (!built) return { outcome: ExportOutcome.MissingTrigger };
	const result = await requestSaveBytes(files, {
		title: labels.dialogTitle,
		suggestedName: suggestedFilename(loaded.def.name, BUNDLE_EXTENSION, {
			defaultStem: "automation",
		}),
		filters: bundleFilters(labels.filterName),
		encode: () => textToBytes(built.text),
	});
	switch (result.kind) {
		case SaveDispositionKind.Saved:
			return { outcome: ExportOutcome.Saved };
		case SaveDispositionKind.Cancelled:
			return { outcome: ExportOutcome.Cancelled };
		case SaveDispositionKind.Failed:
			console.warn("[automations/transfer] export failed", result.error);
			return { outcome: ExportOutcome.Failed };
	}
}

/** Copy a workflow's bundle JSON to the clipboard — the in-sandbox path that
 *  needs no Files capability. `clipboard` is injected for testability. */
export async function exportWorkflowToClipboard(
	entities: EntitiesService | null | undefined,
	loaded: LoadedWorkflow,
	clipboard: Pick<Clipboard, "writeText">,
): Promise<ExportResult> {
	const built = await buildBundleText(entities, loaded);
	if (!built) return { outcome: ExportOutcome.MissingTrigger };
	try {
		await clipboard.writeText(built.text);
		return { outcome: ExportOutcome.Copied };
	} catch (error) {
		console.warn("[automations/transfer] clipboard export failed", error);
		return { outcome: ExportOutcome.Failed };
	}
}

/** File-pick a `.json` bundle, parse it fail-closed, and persist a disabled
 *  trigger+workflow pair with a collision-free display name. */
export async function importWorkflowFromFile(
	entities: EntitiesService | null | undefined,
	files: FilesService,
	existingNames: ReadonlyArray<string>,
	labels: { dialogTitle: string; filterName: string },
): Promise<ImportResult> {
	let handle: { displayName: string; handleId: string } | undefined;
	try {
		const handles = await files.requestOpen({
			title: labels.dialogTitle,
			filters: bundleFilters(labels.filterName),
		});
		[handle] = handles;
		if (!handle) return { outcome: ImportOutcome.Cancelled };
		const bytes = await files.read(handle);
		const text = new TextDecoder().decode(bytes);
		const parsed = parseAutomationBundle(text);
		if (!parsed.ok) return { outcome: ImportOutcome.Invalid, issues: parsed.issues };
		const name = resolveImportName(parsed.bundle.workflow.name, existingNames);
		await persistImportedAutomation(entities, importAutomation(parsed.bundle, name));
		return { outcome: ImportOutcome.Imported, name };
	} catch (error) {
		console.warn("[automations/transfer] import failed", error);
		return { outcome: ImportOutcome.Failed };
	}
}
