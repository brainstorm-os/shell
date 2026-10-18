/**
 * Pure helpers over `Task` state — done-ness, overdue-ness, and which
 * surface a task currently belongs to.
 *
 * Long-term keystones: these survive the Stage 9.14.2 entities-service
 * swap unchanged (Task shape is part of the contract; the storage
 * substrate is not).
 */

import { TaskSurface } from "../types/surface";
import { type Task, TaskStatus } from "../types/task";
import { startOfToday } from "./date-buckets";

export function isDone(task: Task): boolean {
	return task.completedAt !== null;
}

/** The three faces of a task's checkbox (9.14.17). Done stays the canonical
 *  `completedAt !== null`; "won't do" is the seeded Cancelled status on a task
 *  with no completion stamp (it was closed, never finished — so it never
 *  counts as completed, and recurrence math never sees a completion). */
export enum CompletionState {
	Open = "open",
	Done = "done",
	WontDo = "wont-do",
}

export function completionStateOf(task: Pick<Task, "completedAt" | "statusKey">): CompletionState {
	if (task.completedAt !== null) return CompletionState.Done;
	if (task.statusKey === TaskStatus.Cancelled) return CompletionState.WontDo;
	return CompletionState.Open;
}

/** Closed = no longer actionable: done OR won't do. Lists hide closed tasks
 *  behind "show completed" and sink them below open ones; overdue never
 *  applies to them. */
export function isClosed(task: Pick<Task, "completedAt" | "statusKey">): boolean {
	return completionStateOf(task) !== CompletionState.Open;
}

/** When a closed task was closed — its completion stamp, or (won't do has
 *  none) its last write. The sort key that sinks closed rows newest-first. */
export function closedAt(task: Pick<Task, "completedAt" | "updatedAt">): number {
	return task.completedAt ?? task.updatedAt;
}

/** The checkbox click cycle: open → done → won't do → open. */
export function nextCompletionState(state: CompletionState): CompletionState {
	if (state === CompletionState.Open) return CompletionState.Done;
	if (state === CompletionState.Done) return CompletionState.WontDo;
	return CompletionState.Open;
}

/** The `completedAt` + `statusKey` patch that puts a task in `state`. The
 *  status key follows so the board column and the checkbox never disagree:
 *  Done → `done`, won't do → `cancelled`, and reopening clears a terminal
 *  status (a custom / in-progress status on a reopened task is left alone).
 *  Shared by the app's writes and the inline-task block's write-back. */
export function completionPatch(
	priorStatusKey: string | null,
	state: CompletionState,
	now: number,
): Pick<Task, "completedAt" | "statusKey"> {
	if (state === CompletionState.Done) return { completedAt: now, statusKey: TaskStatus.Done };
	if (state === CompletionState.WontDo)
		return { completedAt: null, statusKey: TaskStatus.Cancelled };
	const terminal = priorStatusKey === TaskStatus.Done || priorStatusKey === TaskStatus.Cancelled;
	return { completedAt: null, statusKey: terminal ? null : priorStatusKey };
}

/** The task with `state` applied; an unchanged state returns the input. */
export function withCompletionState(task: Task, state: CompletionState, now: number): Task {
	if (completionStateOf(task) === state) return task;
	return { ...task, ...completionPatch(task.statusKey, state, now), updatedAt: now };
}

export function isOverdue(task: Task, now: number): boolean {
	if (isClosed(task)) return false;
	if (task.dueAt === null) return false;
	return task.dueAt < now;
}

/** The user-facing "you've fallen behind" predicate: a passed deadline
 *  (`isOverdue` → dueAt < now) OR an OPEN task whose scheduled day is already
 *  in the past (scheduledAt < start-of-today). A scheduled date that has
 *  slipped is just as overdue to the user as a missed deadline — without this,
 *  a task scheduled days ago silently sat under the literal "Today" heading
 *  with a dim date chip. The single source of truth shared by the Today-
 *  surface Overdue partition and the row / inspector overdue styling, so a row
 *  shown under "Overdue" always reads as overdue. The `< startOfToday`
 *  boundary keeps tasks scheduled earlier *today* out of overdue. */
export function isPastDue(task: Task, now: number): boolean {
	if (isClosed(task)) return false;
	if (isOverdue(task, now)) return true;
	return task.scheduledAt !== null && task.scheduledAt < startOfToday(now);
}

/** Returns the surface a task currently belongs to.
 *
 *  Project tasks always render under their project (even if scheduled
 *  today), so Project takes precedence. Then a scheduled date picks
 *  Today / Upcoming. The leftover is Inbox.
 *
 *  `endOfToday` is the epoch-ms boundary at 23:59:59.999 of today in
 *  the user's local timezone — passed in by the renderer so this
 *  helper stays pure (no Date.now / no implicit TZ). */
export function surfaceFor(task: Task, endOfToday: number): TaskSurface {
	if (task.projectId !== null) return TaskSurface.Project;
	if (task.scheduledAt !== null) {
		return task.scheduledAt <= endOfToday ? TaskSurface.Today : TaskSurface.Upcoming;
	}
	return TaskSurface.Inbox;
}
