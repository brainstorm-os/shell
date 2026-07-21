import { WorkflowRunStatus } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import type { EntityRecord } from "../storage/runtime";
import { decodeStepLog, toRunView, toRunViews } from "./run-view";

function runRecord(id: string, props: Record<string, unknown>): EntityRecord {
	return { id, type: "brainstorm/WorkflowRun/v1", properties: props, createdAt: 0, updatedAt: 0 };
}

const NAMES = new Map([["wf-1", "Daily digest"]]);

describe("decodeStepLog", () => {
	it("returns no steps for a non-array", () => {
		expect(decodeStepLog(null)).toEqual([]);
		expect(decodeStepLog("nope")).toEqual([]);
	});

	it("decodes entries field-by-field with safe defaults", () => {
		const steps = decodeStepLog([
			{ stepId: "a", kind: "notify", status: "succeeded", depth: 0, durationMs: 12, attempts: 1 },
			{ stepId: "b", kind: "branch", status: "succeeded" },
			"garbage",
			{ stepId: "c", kind: "notify", status: "failed", depth: 1, error: "boom" },
		]);
		expect(steps).toHaveLength(3);
		expect(steps[0]).toMatchObject({ stepId: "a", durationMs: 12, attempts: 1, depth: 0 });
		expect(steps[1]?.depth).toBe(0);
		expect(steps[2]).toMatchObject({ depth: 1, error: "boom" });
	});

	it("floors a fractional depth and ignores a negative one", () => {
		expect(decodeStepLog([{ stepId: "a", kind: "x", status: "ok", depth: 2.7 }])[0]?.depth).toBe(2);
		expect(decodeStepLog([{ stepId: "a", kind: "x", status: "ok", depth: -3 }])[0]?.depth).toBe(0);
	});
});

describe("toRunView", () => {
	it("resolves the workflow name and decodes status + steps", () => {
		const view = toRunView(
			runRecord("run-1", {
				workflow: "wf-1",
				status: WorkflowRunStatus.Succeeded,
				triggeredAt: "2026-06-08T09:00:00.000Z",
				triggeredBy: "trigger-1",
				stepLog: [{ stepId: "n", kind: "notify", status: "succeeded", depth: 0 }],
			}),
			NAMES,
		);
		expect(view.workflowName).toBe("Daily digest");
		expect(view.status).toBe(WorkflowRunStatus.Succeeded);
		expect(view.steps).toHaveLength(1);
	});

	it("falls back to the raw workflow id when unknown", () => {
		const view = toRunView(runRecord("run-1", { workflow: "wf-x", status: "running" }), NAMES);
		expect(view.workflowName).toBe("wf-x");
	});

	it("degrades an unknown status to failed", () => {
		const view = toRunView(runRecord("run-1", { workflow: "wf-1", status: "weird" }), NAMES);
		expect(view.status).toBe(WorkflowRunStatus.Failed);
	});

	it("carries an error message when present", () => {
		const view = toRunView(
			runRecord("run-1", { workflow: "wf-1", status: "failed", error: "kaboom" }),
			NAMES,
		);
		expect(view.error).toBe("kaboom");
	});
});

describe("toRunViews", () => {
	it("sorts newest-first by triggeredAt", () => {
		const views = toRunViews(
			[
				runRecord("a", { workflow: "wf-1", status: "succeeded", triggeredAt: "2026-06-01T00:00:00Z" }),
				runRecord("b", { workflow: "wf-1", status: "succeeded", triggeredAt: "2026-06-08T00:00:00Z" }),
			],
			NAMES,
		);
		expect(views.map((v) => v.id)).toEqual(["b", "a"]);
	});
});
