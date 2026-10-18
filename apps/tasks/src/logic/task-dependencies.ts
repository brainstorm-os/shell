/**
 * Task dependencies (9.14.8) — pure blocking + cycle helpers.
 *
 * A task's `dependsOn` lists the ids of tasks that must complete before it can
 * start; the task is "blocked" while any of those is still open. All functions
 * are pure over a flat task list (or an id→task map) so the row badge, the
 * inspector "Blocked by" section, and the dependency picker share one source of
 * truth, and the cycle guard is provable without a live store.
 */

import type { Task } from "../types/task";
import { isClosed } from "./task-status";

/** A task's dependency ids, normalised (absent → []). */
export function dependenciesOf(task: Task): readonly string[] {
	return task.dependsOn ?? [];
}

/** Build an id→task lookup once for the blocking queries below. */
export function indexById(tasks: readonly Task[]): Map<string, Task> {
	return new Map(tasks.map((t) => [t.id, t]));
}

/** The incomplete tasks blocking `task` — its dependencies that still exist and
 *  are not yet complete (a missing or already-done dependency doesn't block). */
export function blockingTasks(task: Task, byId: ReadonlyMap<string, Task>): Task[] {
	const out: Task[] = [];
	for (const id of dependenciesOf(task)) {
		const dep = byId.get(id);
		if (dep && !isClosed(dep)) out.push(dep);
	}
	return out;
}

/** Is `task` blocked? True when at least one dependency is open. */
export function isBlocked(task: Task, byId: ReadonlyMap<string, Task>): boolean {
	return blockingTasks(task, byId).length > 0;
}

/**
 * Would adding `candidateDepId` to `taskId`'s dependencies create a cycle?
 * True when `candidateDepId` already depends (transitively) on `taskId` — the
 * new edge would close a loop — or is `taskId` itself. Walks the existing
 * `dependsOn` edges from the candidate with a visited-guard so a pre-existing
 * loop can't spin forever.
 */
export function wouldCreateDependencyCycle(
	tasks: readonly Task[],
	taskId: string,
	candidateDepId: string,
): boolean {
	if (candidateDepId === taskId) return true;
	const byId = indexById(tasks);
	const seen = new Set<string>();
	const stack = [candidateDepId];
	while (stack.length > 0) {
		const current = stack.pop();
		if (current === undefined || seen.has(current)) continue;
		seen.add(current);
		const node = byId.get(current);
		if (!node) continue;
		for (const dep of dependenciesOf(node)) {
			if (dep === taskId) return true;
			stack.push(dep);
		}
	}
	return false;
}

/** Candidate tasks that may be added as a blocker of `task`: every other task
 *  that isn't already a dependency and wouldn't create a cycle. Used by the
 *  "Add blocker" picker. */
export function dependencyCandidates(tasks: readonly Task[], task: Task): Task[] {
	const existing = new Set(dependenciesOf(task));
	return tasks.filter(
		(candidate) =>
			candidate.id !== task.id &&
			!existing.has(candidate.id) &&
			!wouldCreateDependencyCycle(tasks, task.id, candidate.id),
	);
}
