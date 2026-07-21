/**
 * Connector-4 — map a `SyncRunResult` to the `brainstorm/SyncRun/v1`
 * entity properties (the provenance record, the analogue of
 * `toWorkflowRunDef`). Persisted by the sync service after each run.
 */

import type { SyncRunDef } from "@brainstorm-os/sdk-types";
import type { SyncRunResult } from "./sync-runner";

export function toSyncRunDef(result: SyncRunResult): SyncRunDef {
	const def: SyncRunDef = {
		mappingRef: result.mappingRef,
		startedAt: result.startedAt,
		finishedAt: result.finishedAt,
		status: result.status,
		pulled: result.pulled,
		pushed: result.pushed,
		conflicts: result.conflicts,
	};
	if (result.error) def.error = result.error;
	return def;
}
