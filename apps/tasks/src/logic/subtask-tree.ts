/**
 * Subtask hierarchy (9.14.7) — pure tree + progress + cycle helpers.
 *
 * A subtask is a `Task` whose `parentId` points at another task. The model is
 * a single level conceptually but the helpers tolerate arbitrary depth (a
 * subtask can itself have children). All functions are pure over a flat task
 * list so the renderer + inspector consume them without owning the math, and
 * the cycle guard can be proven without a live store.
 */

import type { Task } from "../types/task";
import { isClosed } from "./task-status";

/** Direct children of `parentId`, in the order they appear in `tasks`. */
export function childrenOf(tasks: readonly Task[], parentId: string): Task[] {
	return tasks.filter((t) => t.parentId === parentId);
}

/** Top-level tasks (no parent, or a parent that no longer exists — an orphan
 *  subtask surfaces at the top level rather than vanishing). */
export function topLevelTasks(tasks: readonly Task[]): Task[] {
	const ids = new Set(tasks.map((t) => t.id));
	return tasks.filter((t) => t.parentId === null || !ids.has(t.parentId));
}

export type SubtaskProgress = {
	/** Direct children that are complete. */
	done: number;
	/** Direct children total. */
	total: number;
};

/** Completion of a task's *direct* children. `total === 0` means no subtasks
 *  (the caller hides the progress chip). A child counts once it is closed —
 *  done or won't do — so a parent whose last open child is dropped reaches
 *  100%. */
export function subtaskProgress(tasks: readonly Task[], parentId: string): SubtaskProgress {
	const kids = childrenOf(tasks, parentId);
	return {
		done: kids.filter(isClosed).length,
		total: kids.length,
	};
}

/**
 * Would setting `task.parentId = candidateParentId` create a cycle? True when
 * the candidate is the task itself or any of its descendants — assigning it as
 * the parent would make the subtree point back into itself. Walks the existing
 * child edges (excluding the prospective new one) with a visited-guard so a
 * pre-existing loop in malformed data can't spin forever.
 */
export function wouldCreateCycle(
	tasks: readonly Task[],
	taskId: string,
	candidateParentId: string,
): boolean {
	if (candidateParentId === taskId) return true;
	const seen = new Set<string>();
	const stack = [taskId];
	while (stack.length > 0) {
		const current = stack.pop();
		if (current === undefined || seen.has(current)) continue;
		seen.add(current);
		for (const child of childrenOf(tasks, current)) {
			if (child.id === candidateParentId) return true;
			stack.push(child.id);
		}
	}
	return false;
}
