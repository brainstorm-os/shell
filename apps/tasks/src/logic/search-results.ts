/**
 * Inline-search result projection for the Tasks app (9.22.3).
 *
 * Two pure paths, same output shape (`Task[]`, best match first):
 *
 *   - `taskSearchFromHits` — production. The shell's FTS5 index already
 *     ranked the hits; we just project our in-memory tasks down to that
 *     id set, in that order, via the shared SDK `orderByHitRank`.
 *   - `localTaskMatch` — preview / older shells with no `services.search`.
 *     A case-insensitive substring scan over name + notes so the bar is
 *     never dead. Deliberately dumb: the real ranking is the index's job;
 *     this only has to be reasonable when there is no index at all.
 *
 * Splitting this out of `app.ts` keeps the boot/render orchestration thin
 * and the matching logic unit-testable without a DOM.
 */

import { type RankableHit, orderByHitRank } from "@brainstorm-os/sdk";
import type { Task } from "../types/task";

const taskId = (t: Task): string => t.id;

/** Tasks whose id appears in `hits`, in the index's rank order. */
export function taskSearchFromHits(tasks: readonly Task[], hits: readonly RankableHit[]): Task[] {
	return orderByHitRank(tasks, hits, taskId);
}

/** Local fallback when no search service is available. Matches `text`
 *  (trimmed, case-insensitive) as a substring of the task name or notes;
 *  input order preserved. Empty / whitespace `text` → no results (the
 *  caller treats an empty query as "not searching" before this is hit,
 *  but guard anyway so a stray call can't return the whole list). */
export function localTaskMatch(tasks: readonly Task[], text: string): Task[] {
	const needle = text.trim().toLowerCase();
	if (needle.length === 0) return [];
	return tasks.filter((t) => {
		if (t.name.toLowerCase().includes(needle)) return true;
		const notes = t.notes;
		return typeof notes === "string" && notes.toLowerCase().includes(needle);
	});
}
