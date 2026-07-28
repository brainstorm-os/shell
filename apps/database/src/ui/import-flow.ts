/**
 * 9.12.16-UI — the imperative DOM flow that wires the pure
 * `pickAndParseImport` orchestrator to the Database app's create path.
 *
 * Three pieces:
 *   1. `runImportFlow` — async entry. Resolves the runtime services,
 *      calls the orchestrator, dispatches by disposition.
 *   2. `openImportPreviewModal` — `<dialog>`-based per-row preview grid
 *      (slice 2). Each parsed row shows its title + an editable property
 *      bag + (for a duplicate) the existing→merged diff, and a per-row
 *      action toggle (New / Merge / Skip). A live header summary tracks
 *      the toggles; Import commits the overridden plan.
 *   3. `commitImportRun` — iterates the resolved `commands` through
 *      `services.entities.create` / `.update`. Each command logs failure
 *      independently so a single bad row doesn't kill the rest of the
 *      import.
 *
 * Stays imperative DOM (the rest of the Database header is too); the
 * dialog uses native `<dialog>` for focus trap + backdrop + Escape for
 * free. When the shared SDK Popover gets a "modal" variant we'll swap.
 */

import { t } from "../i18n";
import type { ImportAction, ImportCommand, ImportPlanRow } from "../logic/contact-import-plan";
import {
	type ImportFileService,
	PickAndParseKind,
	type PickAndParseResult,
	activeImportMappers,
	pickAndParseImport,
} from "../logic/import-orchestrator";
import {
	type PreviewRow,
	actionVerb,
	buildPreviewRows,
	nextAction,
	parsePreviewValue,
} from "../logic/import-preview";
import type { ExistingEntity, ImportSummary } from "../logic/import-registry";
import { humanize } from "./humanize";

/** Narrowed entities-service shape the commit path consumes. The full
 *  contract lives in `BrainstormRuntime['services']['entities']` in
 *  `app.ts`; this is the slice we actually call. */
export type ImportEntitiesService = {
	create(type: string, properties: Record<string, unknown>, id?: string): Promise<{ id: string }>;
	update?(id: string, patch: Record<string, unknown>): Promise<unknown>;
};

/** Surface the flow uses to talk back to the host (status pill toast +
 *  the live vault snapshot for dedupe). Decouples the flow from
 *  `app.ts`'s state shape so tests can drive it with stub functions. */
export type ImportFlowHost = {
	files: ImportFileService;
	entities: ImportEntitiesService;
	/** Existing rows of `targetType` (already filtered) — handed to the
	 *  orchestrator's plan step for dedupe and to the preview grid for the
	 *  per-row existing→merged diff. */
	existing: readonly ExistingEntity[];
	/** Vault target type — e.g. `brainstorm/Person/v1`. Commands don't
	 *  carry the type themselves (the mapper is what knows its target),
	 *  so the commit path needs it explicit. Future imports targeting
	 *  multiple types can ship per-mapper hosts. */
	targetType: string;
	/** Human label for the type, used in modal copy + toast text. */
	targetTypeLabel: string;
	/** Toast surface. Two severities mirror the existing flashStatus
	 *  vocabulary the rest of the app uses. */
	notify(message: string, severity: "ready" | "warn"): void;
	/** Re-list the vault after a successful commit so the newly-created
	 *  rows show up. The caller's existing reload path (`loadVaultEntities`
	 *  in app.ts). */
	onCommitted(): void | Promise<void>;
};

/** Run the full import flow: pick → parse → preview/override → commit.
 *  Returns the orchestrator disposition for the caller to inspect
 *  (tests). The flow swallows its own dialog lifecycle and toast
 *  notifications so the caller is a one-liner from the menu. */
export async function runImportFlow(
	host: ImportFlowHost,
	options?: { readonly title?: string; readonly filterName?: string },
): Promise<PickAndParseResult> {
	const mappers = activeImportMappers();
	if (mappers.length === 0) {
		host.notify("No import mappers registered", "warn");
		return { kind: PickAndParseKind.NoMapper, filename: "", extension: "" };
	}
	const result = await pickAndParseImport(host.files, {
		mappers,
		existing: host.existing,
		...(options?.title !== undefined ? { title: options.title } : {}),
		...(options?.filterName !== undefined ? { filterName: options.filterName } : {}),
	});
	switch (result.kind) {
		case PickAndParseKind.Cancelled:
			// Silent — cancellation is data, not error.
			return result;
		case PickAndParseKind.NoMapper:
			host.notify(
				result.extension
					? `Unsupported file type: .${result.extension}`
					: `Pick a file with a recognised extension (${mappers.flatMap((m) => m.extensions).join(", ")})`,
				"warn",
			);
			return result;
		case PickAndParseKind.Failed:
			host.notify(`Couldn't read ${result.filename}: ${detail(result.error)}`, "warn");
			console.warn(`[database/import] failed for ${result.filename}:`, result.error);
			return result;
		case PickAndParseKind.EmptyParse:
			host.notify(`Nothing to import from ${result.filename}`, "ready");
			return result;
		case PickAndParseKind.Ready: {
			// The only registered mapper is contacts (`ImportPlanRow`); the
			// grid is built against that concrete shape. The override wire
			// format stays generic via `mapper.commandsFor` so a future
			// mapper generalises the grid without touching commit.
			const plan = result.run.plan as ImportPlanRow[];
			const rows = buildPreviewRows(plan, host.existing, humanize);
			const decision = await openImportPreviewModal({
				filename: result.filename,
				targetTypeLabel: host.targetTypeLabel,
				rows,
				summarize: (overrides) => result.mapper.summarize(plan, overrides),
			});
			if (!decision.confirmed) return result;
			const commands = result.mapper.commandsFor(
				plan,
				decision.actionOverrides,
				decision.propertyOverrides,
			);
			const { created, merged, failed } = await commitImportRun(
				commands,
				host.entities,
				host.targetType,
			);
			if (failed > 0) {
				host.notify(
					t("brainstorm.database.status.importPartial", {
						done: created + merged,
						total: created + merged + failed,
						failed,
					}),
					"warn",
				);
			} else if (created + merged === 0) {
				// No-op path: every row was skipped, or the snapshot changed
				// between plan + commit. Surface an honest nothing-happened
				// message rather than a misleading success toast.
				host.notify(t("brainstorm.database.import.nothing"), "ready");
			} else {
				host.notify(t("brainstorm.database.status.importMerged", { created, merged }), "ready");
			}
			await host.onCommitted();
			return result;
		}
	}
}

/** Iterate `commands`, dispatching each through the entities service.
 *  Per-command try/catch so one bad row doesn't kill the batch — the
 *  user gets partial-success feedback through the caller's toast. */
export async function commitImportRun(
	commands: readonly ImportCommand[],
	entities: ImportEntitiesService,
	targetType: string,
): Promise<{ created: number; merged: number; failed: number }> {
	let created = 0;
	let merged = 0;
	let failed = 0;
	for (const command of commands) {
		try {
			if (command.op === "create") {
				await entities.create(targetType, command.properties);
				created += 1;
				continue;
			}
			// op === "update"
			if (!entities.update) {
				// Shell binding without update support — count the merge as
				// failed rather than silently dropping it. The shell today
				// exposes update, so this is a defense-in-depth branch for
				// future surface changes.
				failed += 1;
				console.warn(`[database/import] merge skipped — entities.update unavailable for ${command.id}`);
				continue;
			}
			await entities.update(command.id, command.properties);
			merged += 1;
		} catch (error) {
			const idHint = command.op === "update" ? command.id : "new";
			failed += 1;
			console.warn(`[database/import] command failed (${command.op} ${idHint}):`, error);
		}
	}
	return { created, merged, failed };
}

/** The user's decision from the preview modal — `confirmed` plus the
 *  per-row override maps the commit path feeds to `mapper.commandsFor`. */
export type ImportPreviewDecision = {
	confirmed: boolean;
	actionOverrides: Record<number, ImportAction>;
	propertyOverrides: Record<number, Record<string, unknown>>;
};

/** Render the per-row preview-and-override grid. Resolves with the
 *  decision on Import, or `{confirmed:false}` on Cancel / Escape /
 *  backdrop. Dialog DOM is removed on close so a re-open is fresh. */
export function openImportPreviewModal(opts: {
	filename: string;
	targetTypeLabel: string;
	rows: readonly PreviewRow[];
	/** Re-derives the header counts for the current action overrides. */
	summarize(overrides: Record<number, ImportAction>): ImportSummary;
}): Promise<ImportPreviewDecision> {
	return new Promise((resolve) => {
		const actionOverrides: Record<number, ImportAction> = {};
		const propertyOverrides: Record<number, Record<string, unknown>> = {};

		const dialog = document.createElement("dialog");
		dialog.className = "db-import-modal db-import-modal--preview";

		const title = document.createElement("h2");
		title.className = "db-import-modal__title";
		title.textContent = t("brainstorm.database.import.title", {
			type: opts.targetTypeLabel.toLowerCase(),
		});

		const filenameLine = document.createElement("p");
		filenameLine.className = "db-import-modal__filename";
		filenameLine.textContent = opts.filename;

		const summaryLine = document.createElement("p");
		summaryLine.className = "db-import-modal__summary";

		const grid = document.createElement("div");
		grid.className = "db-import-grid";
		grid.setAttribute("role", "list");

		const actions = document.createElement("div");
		actions.className = "db-import-modal__actions";

		const cancelBtn = document.createElement("button");
		cancelBtn.type = "button";
		cancelBtn.className = "db-import-modal__cancel";
		cancelBtn.textContent = t("brainstorm.database.import.cancel");

		const importBtn = document.createElement("button");
		importBtn.type = "button";
		importBtn.className = "db-import-modal__import";

		const currentAction = (row: PreviewRow): ImportAction =>
			actionOverrides[row.index] ?? row.defaultAction;

		function refreshSummary(): void {
			const summary = opts.summarize(actionOverrides);
			summaryLine.textContent = summaryText(summary);
			const committable = summary.create + summary.merge;
			importBtn.textContent =
				committable > 0
					? t("brainstorm.database.import.actionCount", { count: committable })
					: t("brainstorm.database.import.action");
			importBtn.disabled = committable === 0;
		}

		for (const row of opts.rows) {
			grid.appendChild(
				buildRowElement(row, currentAction, actionOverrides, propertyOverrides, refreshSummary),
			);
		}

		actions.append(cancelBtn, importBtn);
		dialog.append(title, filenameLine, summaryLine, grid, actions);
		document.body.appendChild(dialog);
		refreshSummary();

		let settled = false;
		function finish(confirmed: boolean): void {
			if (settled) return;
			settled = true;
			try {
				dialog.close();
			} catch {
				// jsdom / a pre-`showModal` close can throw — the DOM teardown
				// below is what actually matters.
			}
			dialog.remove();
			resolve({ confirmed, actionOverrides, propertyOverrides });
		}

		cancelBtn.addEventListener("click", () => finish(false));
		importBtn.addEventListener("click", () => finish(true));
		dialog.addEventListener("click", (event) => {
			if (event.target === dialog) finish(false);
		});
		dialog.addEventListener("close", () => finish(false));

		try {
			dialog.showModal();
		} catch {
			// jsdom doesn't implement showModal; the dialog is still in the
			// document so tests and the close path work. Real Electron has it.
		}
		importBtn.focus();
	});
}

/** Build one grid row: an action toggle, an editable title, a disclosure
 *  for the per-field bag + (merge) diff. All wiring mutates the shared
 *  override maps and re-derives the header summary on action changes. */
function buildRowElement(
	row: PreviewRow,
	currentAction: (row: PreviewRow) => ImportAction,
	actionOverrides: Record<number, ImportAction>,
	propertyOverrides: Record<number, Record<string, unknown>>,
	refreshSummary: () => void,
): HTMLElement {
	const el = document.createElement("div");
	el.className = "db-import-row";
	el.setAttribute("role", "listitem");
	el.dataset.action = currentAction(row);

	const head = document.createElement("div");
	head.className = "db-import-row__head";

	const actionBtn = document.createElement("button");
	actionBtn.type = "button";
	actionBtn.className = "db-import-row__action";
	const applyActionLabel = (action: ImportAction): void => {
		actionBtn.textContent = actionVerb(action);
		// The button cycles, so the SR label states the current verb (not a
		// static "toggle"); the tooltip keeps the cycle hint for sighted use.
		actionBtn.setAttribute(
			"aria-label",
			t("brainstorm.database.import.actionAria", { verb: actionVerb(action) }),
		);
	};
	applyActionLabel(currentAction(row));
	actionBtn.title = t("brainstorm.database.import.toggleRowHint");
	actionBtn.addEventListener("click", () => {
		const next = nextAction(currentAction(row), row.hasMatch);
		if (next === row.defaultAction) delete actionOverrides[row.index];
		else actionOverrides[row.index] = next;
		applyActionLabel(next);
		el.dataset.action = next;
		refreshSummary();
	});

	const titleInput = document.createElement("input");
	titleInput.type = "text";
	titleInput.className = "db-import-row__title";
	titleInput.value = row.title === "(untitled)" ? "" : row.title;
	titleInput.placeholder = "(untitled)";
	titleInput.setAttribute("aria-label", t("brainstorm.database.import.rowNameAria"));
	titleInput.addEventListener("input", () => {
		setOverride(propertyOverrides, row.index, "name", titleInput.value.trim());
	});

	const expandBtn = document.createElement("button");
	expandBtn.type = "button";
	expandBtn.className = "db-import-row__expand";
	expandBtn.textContent = row.hasMatch
		? t("brainstorm.database.import.diff")
		: t("brainstorm.database.import.fields");
	expandBtn.setAttribute("aria-expanded", "false");

	head.append(actionBtn, titleInput, expandBtn);

	const detail = document.createElement("div");
	detail.className = "db-import-row__detail";
	detail.hidden = true;
	detail.append(buildFieldList(row, propertyOverrides));
	if (row.diff.length > 0) detail.append(buildDiffList(row));

	expandBtn.addEventListener("click", () => {
		detail.hidden = !detail.hidden;
		expandBtn.setAttribute("aria-expanded", String(!detail.hidden));
	});

	el.append(head, detail);
	return el;
}

/** Editable field list for a row's property bag (excludes `name`, which
 *  is the head title input). Editable fields get a text input wired to
 *  the override map; the rest render read-only. */
function buildFieldList(
	row: PreviewRow,
	propertyOverrides: Record<number, Record<string, unknown>>,
): HTMLElement {
	const list = document.createElement("dl");
	list.className = "db-import-row__fields";
	for (const field of row.fields) {
		if (field.key === "name") continue;
		const dt = document.createElement("dt");
		dt.textContent = field.label;
		const dd = document.createElement("dd");
		if (field.editable) {
			const input = document.createElement("input");
			input.type = "text";
			input.value = field.value;
			input.setAttribute("aria-label", field.label);
			input.addEventListener("input", () => {
				const parsed = parsePreviewValue(input.value, field.isList ? [] : "");
				setOverride(propertyOverrides, row.index, field.key, parsed);
			});
			dd.appendChild(input);
		} else {
			dd.textContent = field.value;
			dd.classList.add("db-import-row__readonly");
		}
		list.append(dt, dd);
	}
	return list;
}

/** Existing→merged diff list for a matched row. Changed rows carry a
 *  `data-changed` flag the stylesheet highlights. */
function buildDiffList(row: PreviewRow): HTMLElement {
	const wrap = document.createElement("div");
	wrap.className = "db-import-row__diff";
	for (const d of row.diff) {
		const line = document.createElement("div");
		line.className = "db-import-row__diff-line";
		if (d.changed) line.dataset.changed = "true";
		const label = document.createElement("span");
		label.className = "db-import-row__diff-label";
		label.textContent = d.label;
		const before = document.createElement("span");
		before.className = "db-import-row__diff-before";
		before.textContent = d.before || "—";
		const after = document.createElement("span");
		after.className = "db-import-row__diff-after";
		after.textContent = d.after || "—";
		line.append(label, before, after);
		wrap.appendChild(line);
	}
	return wrap;
}

/** Set (or clear) one field of a row's property override. */
function setOverride(
	overrides: Record<number, Record<string, unknown>>,
	index: number,
	key: string,
	value: unknown,
): void {
	let patch = overrides[index];
	if (!patch) {
		patch = {};
		overrides[index] = patch;
	}
	patch[key] = value;
}

/** Human-readable summary line. Suppresses zero-rows verbs so we don't
 *  emit clutter like "0 to merge". The "Nothing to import" copy is
 *  shipped only when every count is zero. */
export function summaryText(summary: { create: number; merge: number; skip: number }): string {
	if (totalCount(summary) === 0) return t("brainstorm.database.import.nothing");
	const parts: string[] = [];
	if (summary.create > 0)
		parts.push(t("brainstorm.database.import.summary.new", { count: summary.create }));
	if (summary.merge > 0)
		parts.push(t("brainstorm.database.import.summary.merge", { count: summary.merge }));
	if (summary.skip > 0)
		parts.push(t("brainstorm.database.import.summary.skip", { count: summary.skip }));
	return parts.join(" · ");
}

function totalCount(summary: { create: number; merge: number; skip: number }): number {
	return summary.create + summary.merge + summary.skip;
}

function detail(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
