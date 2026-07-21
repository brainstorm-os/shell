/**
 * 11b.13 — runs view model (pure core). Turns the raw `WorkflowRun/v1`
 * entity records the scheduler/runner persist into a sorted, inspectable
 * view: the run's status + relative time, the originating workflow's name,
 * and the depth-tagged `stepLog` the runner writes (each entry =
 * input/output/duration/attempts/status/depth, so the inspector can render
 * Branch/ForEach nesting). Decode is defensive — a malformed run row
 * degrades to safe defaults and never throws.
 */

import { type WorkflowRunStatus, isWorkflowRunStatus } from "@brainstorm-os/sdk-types";
import type { EntityRecord } from "../storage/runtime";

/** A decoded `stepLog` entry. The runner writes a flat, depth-tagged list;
 *  `depth > 0` marks a step inside a Branch/ForEach body. */
export type RunStep = {
	stepId: string;
	kind: string;
	status: string;
	depth: number;
	durationMs?: number;
	attempts?: number;
	error?: string;
};

export type RunView = {
	id: string;
	workflowId: string;
	workflowName: string;
	status: WorkflowRunStatus;
	triggeredAtMs: number;
	triggeredBy: string;
	error?: string;
	costCents?: number;
	steps: RunStep[];
};

function asString(v: unknown, fallback = ""): string {
	return typeof v === "string" ? v : fallback;
}

function asFiniteNumber(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Decode a persisted `stepLog` (the runner writes an array; anything else
 *  yields no steps). Each entry is read field-by-field with safe defaults. */
export function decodeStepLog(raw: unknown): RunStep[] {
	if (!Array.isArray(raw)) return [];
	const steps: RunStep[] = [];
	for (const entry of raw) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as Record<string, unknown>;
		const depth = asFiniteNumber(e.depth);
		const step: RunStep = {
			stepId: asString(e.stepId),
			kind: asString(e.kind),
			status: asString(e.status),
			depth: depth !== undefined && depth >= 0 ? Math.floor(depth) : 0,
		};
		const duration = asFiniteNumber(e.durationMs);
		if (duration !== undefined) step.durationMs = duration;
		const attempts = asFiniteNumber(e.attempts);
		if (attempts !== undefined) step.attempts = attempts;
		const error = asString(e.error, "");
		if (error !== "") step.error = error;
		steps.push(step);
	}
	return steps;
}

/** Build a `RunView` from one `WorkflowRun/v1` record. `workflowNameById`
 *  resolves the originating workflow's display name; an unknown id falls
 *  back to the raw id so an orphaned run is still legible. */
export function toRunView(
	record: EntityRecord,
	workflowNameById: ReadonlyMap<string, string>,
): RunView {
	const p = record.properties ?? {};
	const workflowId = asString(p.workflow);
	const statusRaw = p.status;
	const triggeredAtMs = Date.parse(asString(p.triggeredAt));
	const view: RunView = {
		id: record.id,
		workflowId,
		workflowName: workflowNameById.get(workflowId) ?? workflowId,
		status: isWorkflowRunStatus(statusRaw)
			? (statusRaw as WorkflowRunStatus)
			: ("failed" as WorkflowRunStatus),
		triggeredAtMs: Number.isNaN(triggeredAtMs) ? 0 : triggeredAtMs,
		triggeredBy: asString(p.triggeredBy),
		steps: decodeStepLog(p.stepLog),
	};
	const error = asString(p.error, "");
	if (error !== "") view.error = error;
	const cost = asFiniteNumber(p.costCents);
	if (cost !== undefined) view.costCents = cost;
	return view;
}

/** All runs as views, newest first (ties broken by id for a stable order). */
export function toRunViews(
	records: readonly EntityRecord[],
	workflowNameById: ReadonlyMap<string, string>,
): RunView[] {
	return records
		.map((r) => toRunView(r, workflowNameById))
		.sort((a, b) => b.triggeredAtMs - a.triggeredAtMs || (a.id < b.id ? 1 : -1));
}
