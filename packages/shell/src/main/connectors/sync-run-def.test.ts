import { SyncRunStatus } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import { toSyncRunDef } from "./sync-run-def";
import type { SyncRunResult } from "./sync-runner";

describe("toSyncRunDef", () => {
	it("maps a result to SyncRun/v1 props, omitting an absent error", () => {
		const result: SyncRunResult = {
			mappingRef: "mapping-1",
			status: SyncRunStatus.Succeeded,
			startedAt: "2026-06-06T00:00:00Z",
			finishedAt: "2026-06-06T00:00:01Z",
			pulled: 5,
			pushed: 0,
			conflicts: 0,
		};
		expect(toSyncRunDef(result)).toEqual({
			mappingRef: "mapping-1",
			startedAt: "2026-06-06T00:00:00Z",
			finishedAt: "2026-06-06T00:00:01Z",
			status: SyncRunStatus.Succeeded,
			pulled: 5,
			pushed: 0,
			conflicts: 0,
		});
	});

	it("carries an error through on a failed run", () => {
		const def = toSyncRunDef({
			mappingRef: "m",
			status: SyncRunStatus.Failed,
			startedAt: "a",
			finishedAt: "b",
			pulled: 0,
			pushed: 0,
			conflicts: 0,
			error: "boom",
		});
		expect(def.error).toBe("boom");
	});
});
