/**
 * Failed-run badge core (7.14 follow-up) — pure functions behind the
 * app-icon badge: which runs count as failures the user hasn't seen yet.
 *
 * Seen semantics are app-owned: opening the Runs tab acknowledges every
 * currently-failed run (that's where the failures are inspected), so the
 * badge counts only failures that arrived since the tab was last viewed.
 * The acknowledged set persists in the app-private `storage.kv` store and
 * is pruned to the live failed set on each ack, so it can't grow without
 * bound as old runs age out.
 */

import { isFailedRunStatus } from "../widget-data";
import type { RunView } from "./run-view";

export const SEEN_FAILED_RUNS_KEY = "automations:seen-failed-runs";

/** Ids of the failure-shaped runs (failed / timed-out), newest-first as the
 *  runs list already is. */
export function failedRunIds(runs: readonly RunView[]): string[] {
	return runs.filter((r) => isFailedRunStatus(r.status)).map((r) => r.id);
}

/** Failures the user hasn't acknowledged yet — the badge count. */
export function unseenFailedCount(failedIds: readonly string[], seen: ReadonlySet<string>): number {
	let count = 0;
	for (const id of failedIds) if (!seen.has(id)) count += 1;
	return count;
}

/** Defensive decode of the persisted acknowledged-id list — keeps only
 *  strings so a corrupt value degrades to "nothing seen", never a crash. */
export function decodeSeenRunIds(raw: unknown): ReadonlySet<string> {
	if (!Array.isArray(raw)) return new Set();
	return new Set(raw.filter((id): id is string => typeof id === "string"));
}

/** Set equality for the ack effect's short-circuit. */
export function sameIdSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	if (a.size !== b.size) return false;
	for (const id of a) if (!b.has(id)) return false;
	return true;
}
