/**
 * The one reading of a `brainstorm/Task/v1` property bag's open/closed state,
 * for every surface that is not the Tasks app itself (dashboard widget, shell
 * item alerts, Calendar, the editor's inline task chip).
 *
 * A task closes two ways: it is done (`completedAt` stamped, or the seeded
 * `done` status) or it is "won't do" (the seeded `cancelled` status with no
 * completion stamp). Reading `completedAt` alone — the pre-9.14.17 signal —
 * leaves a won't-do task looking open: listed as open, still firing "due"
 * alerts, still painted overdue.
 *
 * Pure — raw property bags in, booleans out; safe in the main process, a
 * worker or a widget.
 */

export const TASK_ENTITY_TYPE = "brainstorm/Task/v1";

/** The seeded terminal keys of the `task-status` vocabulary. `statusKey` is
 *  an open domain (users add their own states), so only these two are
 *  terminal. */
export const TerminalTaskStatus = {
	Done: "done",
	Cancelled: "cancelled",
} as const;

export type TaskStateBag = Readonly<Record<string, unknown>> | null | undefined;

function stamped(value: unknown): boolean {
	return typeof value === "number" && Number.isFinite(value);
}

/** Done: a completion stamp, or the seeded `done` status. */
export function isTaskDone(properties: TaskStateBag): boolean {
	if (!properties) return false;
	return stamped(properties.completedAt) || properties.statusKey === TerminalTaskStatus.Done;
}

/** Won't do: closed without ever being finished. */
export function isTaskWontDo(properties: TaskStateBag): boolean {
	if (!properties) return false;
	return !isTaskDone(properties) && properties.statusKey === TerminalTaskStatus.Cancelled;
}

/** Closed = no longer actionable: done OR won't do. */
export function isTaskClosed(properties: TaskStateBag): boolean {
	return isTaskDone(properties) || isTaskWontDo(properties);
}

/** Whether a status key is one of the seeded terminal states. */
export function isTerminalTaskStatus(statusKey: unknown): boolean {
	return statusKey === TerminalTaskStatus.Done || statusKey === TerminalTaskStatus.Cancelled;
}

/** The status key a reopened task keeps: a terminal status is cleared, any
 *  other (in progress, a custom state) survives the reopen. */
export function reopenedStatusKey(priorStatusKey: unknown): string | null {
	if (typeof priorStatusKey !== "string" || isTerminalTaskStatus(priorStatusKey)) return null;
	return priorStatusKey;
}
