/**
 * Automations `recent-runs` dashboard widget — pure data-shaping coverage.
 * The `shapeRuns` projection (order / join / failed-count / tone) is the
 * widget's only non-presentational logic; the component shell mirrors the
 * real-shell-verified Contacts widget.
 */

import { WORKFLOW_RUN_TYPE_URL, WORKFLOW_TYPE_URL, WorkflowRunStatus } from "@brainstorm/sdk-types";
import { describe, expect, it } from "vitest";
import { RunTone, type WidgetRunEntity, runTone, shapeRuns } from "./widget-data";

function workflow(id: string, name: string, deletedAt: number | null = null): WidgetRunEntity {
	return { id, type: WORKFLOW_TYPE_URL, properties: { name, enabled: true }, deletedAt };
}

function run(
	id: string,
	workflowId: string,
	triggeredAt: string,
	status: WorkflowRunStatus = WorkflowRunStatus.Succeeded,
	deletedAt: number | null = null,
): WidgetRunEntity {
	return {
		id,
		type: WORKFLOW_RUN_TYPE_URL,
		properties: { workflow: workflowId, triggeredAt, triggeredBy: "trg_1", status },
		deletedAt,
	};
}

describe("shapeRuns", () => {
	it("orders newest triggeredAt (ISO) first, ties broken by id", () => {
		const entities = [
			workflow("wf_1", "Nightly"),
			run("r_old", "wf_1", "2026-07-01T08:00:00.000Z"),
			run("r_new", "wf_1", "2026-07-03T09:30:00.000Z"),
			run("r_mid", "wf_1", "2026-07-02T18:45:00.000Z"),
		];
		const { runs } = shapeRuns(entities);
		expect(runs.map((r) => r.id)).toEqual(["r_new", "r_mid", "r_old"]);
	});

	it("joins each run's workflow name; a deleted or missing workflow yields null", () => {
		const entities = [
			workflow("wf_live", "Weekly review"),
			workflow("wf_gone", "Old workflow", 123),
			run("r_live", "wf_live", "2026-07-03T10:00:00.000Z"),
			run("r_gone", "wf_gone", "2026-07-03T09:00:00.000Z"),
			run("r_orphan", "wf_never", "2026-07-03T08:00:00.000Z"),
		];
		const byId = new Map(shapeRuns(entities).runs.map((r) => [r.id, r.workflowName]));
		expect(byId.get("r_live")).toBe("Weekly review");
		expect(byId.get("r_gone")).toBeNull();
		expect(byId.get("r_orphan")).toBeNull();
	});

	it("counts Failed + TimedOut among the shown runs as failedCount", () => {
		const entities = [
			workflow("wf_1", "Nightly"),
			run("r_1", "wf_1", "2026-07-03T04:00:00.000Z", WorkflowRunStatus.Succeeded),
			run("r_2", "wf_1", "2026-07-03T03:00:00.000Z", WorkflowRunStatus.Failed),
			run("r_3", "wf_1", "2026-07-03T02:00:00.000Z", WorkflowRunStatus.TimedOut),
			run("r_4", "wf_1", "2026-07-03T01:00:00.000Z", WorkflowRunStatus.Cancelled),
		];
		expect(shapeRuns(entities).failedCount).toBe(2);
	});

	it("does not count a failed run pushed out by the limit", () => {
		const entities: WidgetRunEntity[] = [workflow("wf_1", "Nightly")];
		for (let i = 0; i < 8; i++) {
			entities.push(
				run(`r_ok_${i}`, "wf_1", `2026-07-02T1${i}:00:00.000Z`, WorkflowRunStatus.Succeeded),
			);
		}
		entities.push(run("r_failed", "wf_1", "2026-07-01T00:00:00.000Z", WorkflowRunStatus.Failed));
		const { runs, failedCount } = shapeRuns(entities, 8);
		expect(runs).toHaveLength(8);
		expect(runs.some((r) => r.id === "r_failed")).toBe(false);
		expect(failedCount).toBe(0);
	});

	it("maps every status enum member to its tone", () => {
		expect(runTone(WorkflowRunStatus.Failed)).toBe(RunTone.Danger);
		expect(runTone(WorkflowRunStatus.TimedOut)).toBe(RunTone.Danger);
		expect(runTone(WorkflowRunStatus.Running)).toBe(RunTone.Accent);
		expect(runTone(WorkflowRunStatus.Queued)).toBe(RunTone.Accent);
		expect(runTone(WorkflowRunStatus.Succeeded)).toBe(RunTone.Dim);
		expect(runTone(WorkflowRunStatus.Cancelled)).toBe(RunTone.Faint);
	});

	it("stamps each shaped run with the tone of its status", () => {
		const entities = [
			workflow("wf_1", "Nightly"),
			run("r_fail", "wf_1", "2026-07-03T02:00:00.000Z", WorkflowRunStatus.Failed),
			run("r_run", "wf_1", "2026-07-03T01:00:00.000Z", WorkflowRunStatus.Running),
		];
		const byId = new Map(shapeRuns(entities).runs.map((r) => [r.id, r.tone]));
		expect(byId.get("r_fail")).toBe(RunTone.Danger);
		expect(byId.get("r_run")).toBe(RunTone.Accent);
	});

	it("degrades an unknown status to Failed (attention-worthy, mirrors run-view)", () => {
		const bad: WidgetRunEntity = {
			id: "r_bad",
			type: WORKFLOW_RUN_TYPE_URL,
			properties: { workflow: "wf_1", triggeredAt: "2026-07-03T00:00:00.000Z", status: "???" },
			deletedAt: null,
		};
		const { runs, failedCount } = shapeRuns([workflow("wf_1", "Nightly"), bad]);
		expect(runs[0]?.status).toBe(WorkflowRunStatus.Failed);
		expect(failedCount).toBe(1);
	});

	it("skips deleted runs and entities of other types", () => {
		const entities = [
			workflow("wf_1", "Nightly"),
			run("r_live", "wf_1", "2026-07-03T00:00:00.000Z"),
			run("r_deleted", "wf_1", "2026-07-03T01:00:00.000Z", WorkflowRunStatus.Failed, 999),
			{
				id: "note_1",
				type: "brainstorm/Note/v1",
				properties: { triggeredAt: "2026-07-03T02:00:00.000Z" },
				deletedAt: null,
			},
		];
		const { runs, failedCount } = shapeRuns(entities);
		expect(runs.map((r) => r.id)).toEqual(["r_live"]);
		expect(failedCount).toBe(0);
	});

	it("caps the list at the limit (default 8)", () => {
		const entities: WidgetRunEntity[] = [workflow("wf_1", "Nightly")];
		for (let i = 0; i < 12; i++) {
			entities.push(run(`r_${i}`, "wf_1", `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`));
		}
		const { runs } = shapeRuns(entities);
		expect(runs).toHaveLength(8);
		// Newest-first: the highest June dates survive the cap.
		expect(runs[0]?.id).toBe("r_11");
		expect(runs[7]?.id).toBe("r_4");
	});

	it("parses ISO triggeredAt into epoch ms; a malformed value sorts last as 0", () => {
		const entities = [
			workflow("wf_1", "Nightly"),
			run("r_ok", "wf_1", "2026-07-03T12:00:00.000Z"),
			run("r_bad", "wf_1", "not-a-date"),
		];
		const { runs } = shapeRuns(entities);
		expect(runs.map((r) => r.id)).toEqual(["r_ok", "r_bad"]);
		expect(runs[0]?.triggeredAtMs).toBe(Date.parse("2026-07-03T12:00:00.000Z"));
		expect(runs[1]?.triggeredAtMs).toBe(0);
	});
});
