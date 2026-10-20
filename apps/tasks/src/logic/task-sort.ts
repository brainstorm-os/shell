/**
 * Sort model for the list surfaces (Inbox / Today / Upcoming / Project).
 *
 * `TaskSort.Default` is the sentinel for "leave the surface's native order
 * untouched" — the compiler keeps its per-surface ordering (and any manual
 * `sortIndex` on the flat lists). Every other key is an explicit override
 * applied within each compiled section.
 *
 * All comparators share one invariant with the native sorts they replace:
 * open tasks come first, completed tasks always sink to the bottom in
 * most-recently-completed order. The per-key comparator only orders the
 * open tasks among themselves.
 */

import { PRIORITIES, type Priority, type Task } from "../types/task";
import { closedAt, isClosed } from "./task-status";

export enum TaskSort {
	/** Keep the surface's built-in order (honours manual `sortIndex`). */
	Default = "default",
	Priority = "priority",
	DueDate = "due",
	Name = "name",
	Created = "created",
}

/** Render order for the Sort picker — Default first as the reset. */
export const TASK_SORTS: readonly TaskSort[] = Object.freeze([
	TaskSort.Default,
	TaskSort.Priority,
	TaskSort.DueDate,
	TaskSort.Name,
	TaskSort.Created,
]);

/** Priority rank — higher numbers sort first. `PRIORITIES` is declared in
 *  display order (None first → Critical last); the rank inverts so Critical
 *  ranks highest. Shared with the surface compiler's tie-breaks. */
export const PRIORITY_RANK: Record<Priority, number> = Object.fromEntries(
	PRIORITIES.map((p, i) => [p, i + 1]),
) as Record<Priority, number>;

/** Open-before-done ordering, done by completedAt desc. Returns `null` when
 *  both tasks are open so the caller's key comparator decides their order. */
function doneLast(a: Task, b: Task): number | null {
	const aDone = isClosed(a);
	const bDone = isClosed(b);
	if (aDone !== bDone) return aDone ? 1 : -1;
	if (aDone && bDone) return closedAt(b) - closedAt(a);
	return null;
}

/** Per-key comparator over two OPEN tasks (done-ness is handled upstream). */
const OPEN_COMPARATOR: Record<Exclude<TaskSort, TaskSort.Default>, (a: Task, b: Task) => number> = {
	[TaskSort.Priority]: (a, b) => {
		const dp = (PRIORITY_RANK[b.priority] ?? 0) - (PRIORITY_RANK[a.priority] ?? 0);
		return dp !== 0 ? dp : a.createdAt - b.createdAt;
	},
	[TaskSort.DueDate]: (a, b) => {
		const ak = a.dueAt ?? a.scheduledAt ?? null;
		const bk = b.dueAt ?? b.scheduledAt ?? null;
		if (ak !== null && bk !== null && ak !== bk) return ak - bk;
		if (ak === null && bk !== null) return 1;
		if (bk === null && ak !== null) return -1;
		const dp = (PRIORITY_RANK[b.priority] ?? 0) - (PRIORITY_RANK[a.priority] ?? 0);
		return dp !== 0 ? dp : a.createdAt - b.createdAt;
	},
	[TaskSort.Name]: (a, b) => {
		const byName = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
		return byName !== 0 ? byName : a.createdAt - b.createdAt;
	},
	[TaskSort.Created]: (a, b) => b.createdAt - a.createdAt,
};

/** Apply an explicit sort to a list of tasks. `Default` is a no-op (the
 *  caller keeps the native order). Pure — returns a new array. */
export function sortTasks(tasks: readonly Task[], sort: TaskSort): Task[] {
	if (sort === TaskSort.Default) return [...tasks];
	const open = OPEN_COMPARATOR[sort];
	return [...tasks].sort((a, b) => {
		const d = doneLast(a, b);
		return d !== null ? d : open(a, b);
	});
}
