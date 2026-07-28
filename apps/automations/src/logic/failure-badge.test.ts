/**
 * 7.14 follow-up — the failed-run badge core: failure filtering, the
 * unseen count, the defensive decode of the persisted ack list, and the
 * ack effect's set-equality short-circuit.
 */

import { WorkflowRunStatus } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { decodeSeenRunIds, failedRunIds, sameIdSet, unseenFailedCount } from "./failure-badge";
import type { RunView } from "./run-view";

function run(id: string, status: WorkflowRunStatus): RunView {
	return {
		id,
		workflowId: "wf",
		workflowName: "Nightly",
		status,
		triggeredAtMs: 0,
		triggeredBy: "schedule",
		steps: [],
	};
}

describe("failedRunIds", () => {
	it("keeps failed + timed-out runs, drops the rest", () => {
		expect(
			failedRunIds([
				run("r1", WorkflowRunStatus.Failed),
				run("r2", WorkflowRunStatus.Succeeded),
				run("r3", WorkflowRunStatus.TimedOut),
				run("r4", WorkflowRunStatus.Running),
				run("r5", WorkflowRunStatus.Cancelled),
			]),
		).toEqual(["r1", "r3"]);
	});
});

describe("unseenFailedCount", () => {
	it("counts only failures outside the acknowledged set", () => {
		expect(unseenFailedCount(["r1", "r2", "r3"], new Set(["r2"]))).toBe(2);
		expect(unseenFailedCount(["r1"], new Set(["r1"]))).toBe(0);
		expect(unseenFailedCount([], new Set())).toBe(0);
	});
});

describe("decodeSeenRunIds", () => {
	it("keeps only strings and degrades garbage to the empty set", () => {
		expect([...decodeSeenRunIds(["a", 1, null, "b"])]).toEqual(["a", "b"]);
		expect(decodeSeenRunIds(null).size).toBe(0);
		expect(decodeSeenRunIds({ a: 1 }).size).toBe(0);
	});
});

describe("sameIdSet", () => {
	it("compares by membership", () => {
		expect(sameIdSet(new Set(["a", "b"]), new Set(["b", "a"]))).toBe(true);
		expect(sameIdSet(new Set(["a"]), new Set(["a", "b"]))).toBe(false);
		expect(sameIdSet(new Set(["a"]), new Set(["b"]))).toBe(false);
	});
});
