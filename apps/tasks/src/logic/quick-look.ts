/**
 * Quick-look fact sheet — the pure projection behind `intent.quick-look`
 * (the Cmd+L "peek" another app dispatches at a Task). Maps a `Task` +
 * project lookup to an ordered list of `{ labelKey, value }` rows; the
 * DOM popover (`ui/quick-look-view.ts`) only lays these out, so the
 * field-selection rules are unit-testable without a renderer.
 *
 * Rows are emitted only when they carry signal (no empty "Project: —"
 * noise); an always-present Status row anchors the sheet so an
 * otherwise-bare task still reads as a task.
 */

import { summarizeRecurrence } from "@brainstorm-os/sdk-types";
import type { RecurrenceSummaryLabels } from "@brainstorm-os/sdk-types";
import type { Project } from "../types/project";
import { Priority, type Task } from "../types/task";

export type QuickLookRow = {
	/** i18n key for the row's field name. */
	labelKey: string;
	/** Already-resolved display value (dates pre-formatted by the caller). */
	value: string;
};

export type QuickLookSheet = {
	title: string;
	rows: QuickLookRow[];
};

const PRIORITY_LABEL_KEY: Record<Priority, string> = {
	[Priority.None]: "tasks.priority.none",
	[Priority.Low]: "tasks.priority.low",
	[Priority.Medium]: "tasks.priority.medium",
	[Priority.High]: "tasks.priority.high",
	[Priority.Critical]: "tasks.priority.critical",
};

export type QuickLookContext = {
	task: Task;
	projectsById: ReadonlyMap<string, Project>;
	/** Resolver for an epoch-ms date → display string (the app passes its
	 *  `formatDateRelative` bound to `now`). Kept injected so this stays
	 *  pure + locale-agnostic. */
	formatDate: (epochMs: number) => string;
	/** Translate function — injected so the module never imports the app
	 *  manifest (keeps it a leaf). */
	t: (key: string, params?: Record<string, string | number>) => string;
	recurrenceLabels: RecurrenceSummaryLabels;
};

export function buildQuickLookSheet(ctx: QuickLookContext): QuickLookSheet {
	const { task, projectsById, formatDate, t } = ctx;
	const rows: QuickLookRow[] = [];

	rows.push({
		labelKey: "tasks.quickLook.field.status",
		value:
			task.completedAt !== null ? t("tasks.quickLook.value.done") : t("tasks.quickLook.value.open"),
	});

	if (task.projectId !== null) {
		const project = projectsById.get(task.projectId);
		if (project) {
			rows.push({ labelKey: "tasks.quickLook.field.project", value: project.name });
		}
	}

	if (task.priority !== Priority.None) {
		rows.push({
			labelKey: "tasks.quickLook.field.priority",
			value: t(PRIORITY_LABEL_KEY[task.priority]),
		});
	}

	if (task.dueAt !== null) {
		rows.push({ labelKey: "tasks.quickLook.field.due", value: formatDate(task.dueAt) });
	}

	if (task.scheduledAt !== null) {
		rows.push({
			labelKey: "tasks.quickLook.field.scheduled",
			value: formatDate(task.scheduledAt),
		});
	}

	if (task.recurrence !== null) {
		rows.push({
			labelKey: "tasks.quickLook.field.recurrence",
			value: summarizeRecurrence(task.recurrence, ctx.recurrenceLabels),
		});
	}

	const notes = task.notes?.trim();
	if (notes) {
		rows.push({ labelKey: "tasks.quickLook.field.notes", value: notes });
	}

	return { title: task.name, rows };
}
