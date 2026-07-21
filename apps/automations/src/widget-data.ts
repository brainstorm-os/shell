/**
 * Pure data-shaping for the Automations `recent-runs` dashboard widget — no
 * React / CSS imports, so it's unit-testable in isolation (mirrors the
 * Contacts widget split). `widget.tsx` is a thin presentational shell over
 * `shapeRuns`.
 */

import {
	type VaultEntitiesListQuery,
	WORKFLOW_RUN_TYPE_URL,
	WORKFLOW_TYPE_URL,
	WorkflowRunStatus,
	isWorkflowRunStatus,
} from "@brainstorm-os/sdk-types";
import type { AutomationsI18nKey } from "./i18n";

/** Manifest widget id — must match `registrations.widgets[].id` in manifest.json. */
export const AUTOMATIONS_WIDGET_RECENT_RUNS = "recent-runs";

/** Default number of runs the glance list shows. */
export const RUNS_LIMIT = 8;

/** Server-side narrowing for the widget's `useVaultEntities` subscription
 *  (F-384): only the run rows + the workflows they join against. Module-level
 *  so the reference stays stable across renders (a fresh object identity per
 *  render would re-subscribe the store). */
export const AUTOMATIONS_WIDGET_QUERY: VaultEntitiesListQuery = {
	types: [WORKFLOW_RUN_TYPE_URL, WORKFLOW_TYPE_URL],
};

/** Visual weight of a run's status chip — maps onto the theme tone vars. */
export enum RunTone {
	Danger = "danger",
	Accent = "accent",
	Dim = "dim",
	Faint = "faint",
}

const RUN_STATUS_TONE: Record<WorkflowRunStatus, RunTone> = {
	[WorkflowRunStatus.Failed]: RunTone.Danger,
	[WorkflowRunStatus.TimedOut]: RunTone.Danger,
	[WorkflowRunStatus.Running]: RunTone.Accent,
	[WorkflowRunStatus.Queued]: RunTone.Accent,
	[WorkflowRunStatus.Succeeded]: RunTone.Dim,
	[WorkflowRunStatus.Cancelled]: RunTone.Faint,
};

export function runTone(status: WorkflowRunStatus): RunTone {
	return RUN_STATUS_TONE[status];
}

/** Localized status label — keyed off the enum onto the existing 11b.13
 *  runs-view catalog entries, never a raw literal. */
const RUN_STATUS_LABEL_KEY: Record<WorkflowRunStatus, AutomationsI18nKey> = {
	[WorkflowRunStatus.Queued]: "runs.status.queued",
	[WorkflowRunStatus.Running]: "runs.status.running",
	[WorkflowRunStatus.Succeeded]: "runs.status.succeeded",
	[WorkflowRunStatus.Failed]: "runs.status.failed",
	[WorkflowRunStatus.Cancelled]: "runs.status.cancelled",
	[WorkflowRunStatus.TimedOut]: "runs.status.timed-out",
};

export function runStatusLabelKey(status: WorkflowRunStatus): AutomationsI18nKey {
	return RUN_STATUS_LABEL_KEY[status];
}

/** The failure-shaped terminal statuses the count chip flags. */
const FAILED_RUN_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set([
	WorkflowRunStatus.Failed,
	WorkflowRunStatus.TimedOut,
]);

export function isFailedRunStatus(status: WorkflowRunStatus): boolean {
	return FAILED_RUN_STATUSES.has(status);
}

export type WidgetRun = {
	id: string;
	/** The originating `Workflow/v1` id (the run's `workflow` entity ref) —
	 *  the row-click open target (the workflow holds the registered opener). */
	workflowId: string;
	/** Resolved workflow display name; null when the workflow is deleted /
	 *  missing (the row renders the dim deleted-workflow fallback). */
	workflowName: string | null;
	status: WorkflowRunStatus;
	tone: RunTone;
	triggeredAtMs: number;
};

/** The minimal vault-entity shape the widget reads (a subset of the live
 *  snapshot's rows) — kept local so the shaper is testable without the full
 *  `react-yjs` entity type. */
export type WidgetRunEntity = {
	id: string;
	type: string;
	properties: Record<string, unknown>;
	deletedAt: number | null;
};

function workflowDisplayName(properties: Record<string, unknown>): string | null {
	const name = properties.name;
	return typeof name === "string" && name.trim().length > 0 ? name : null;
}

function toWidgetRun(
	entity: WidgetRunEntity,
	workflowNameById: ReadonlyMap<string, string | null>,
): WidgetRun {
	const p = entity.properties;
	const workflowId = typeof p.workflow === "string" ? p.workflow : "";
	// Mirror the 11b.13 run-view decode: an unknown status degrades to Failed
	// (a run the runner can't account for should read as attention-worthy).
	const status = isWorkflowRunStatus(p.status) ? p.status : WorkflowRunStatus.Failed;
	const triggeredAtMs = Date.parse(typeof p.triggeredAt === "string" ? p.triggeredAt : "");
	return {
		id: entity.id,
		workflowId,
		workflowName: workflowNameById.get(workflowId) ?? null,
		status,
		tone: runTone(status),
		triggeredAtMs: Number.isNaN(triggeredAtMs) ? 0 : triggeredAtMs,
	};
}

/** Filter the live snapshot to non-deleted `WorkflowRun/v1`, join each run's
 *  workflow name from the same snapshot, order newest `triggeredAt` first
 *  (ties broken by id for a stable order), and cap at `limit`. `failedCount`
 *  is derived over the *shown* runs — the count chip flags what the glance
 *  list actually displays. */
export function shapeRuns(
	entities: readonly WidgetRunEntity[],
	limit = RUNS_LIMIT,
): { runs: WidgetRun[]; failedCount: number } {
	const workflowNameById = new Map<string, string | null>();
	for (const e of entities) {
		if (e.type === WORKFLOW_TYPE_URL && e.deletedAt === null) {
			workflowNameById.set(e.id, workflowDisplayName(e.properties));
		}
	}
	const runs = entities
		.filter((e) => e.type === WORKFLOW_RUN_TYPE_URL && e.deletedAt === null)
		.map((e) => toWidgetRun(e, workflowNameById))
		.sort((a, b) => b.triggeredAtMs - a.triggeredAtMs || (a.id < b.id ? 1 : -1))
		.slice(0, limit);
	const failedCount = runs.filter((r) => isFailedRunStatus(r.status)).length;
	return { runs, failedCount };
}
