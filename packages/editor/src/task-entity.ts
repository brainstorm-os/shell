/**
 * The task facts the editor needs to render and toggle an inline task
 * (B11.24) — kept dependency-free so the mention node can read them without
 * importing the `/task` command module.
 */

import {
	TASK_ENTITY_TYPE,
	TerminalTaskStatus,
	isTaskClosed,
	isTaskDone,
	isTaskWontDo,
	reopenedStatusKey,
} from "@brainstorm-os/sdk/task-state";

export { TASK_ENTITY_TYPE, isTaskClosed, isTaskDone, isTaskWontDo };

/** Marks the checkbox so click-to-open handlers on mention chips skip it. */
export const TASK_CHECK_ATTR = "data-bs-task-check";

/** The completion patch — identical to the Tasks inline-task block's: done
 *  stamps `done`, reopening clears only a terminal status so an in-progress
 *  or custom state survives. */
export function taskCompletionPatch(
	done: boolean,
	now: number = Date.now(),
	priorStatusKey: unknown = null,
): Record<string, unknown> {
	return done
		? { statusKey: TerminalTaskStatus.Done, completedAt: now }
		: { statusKey: reopenedStatusKey(priorStatusKey), completedAt: null };
}

/** A new task's property bag (mirrors the agent `propose-task` persist plan). */
export function newTaskProperties(name: string, now: number = Date.now()): Record<string, unknown> {
	return {
		name,
		statusKey: null,
		completedAt: null,
		priority: "none",
		dueAt: null,
		scheduledAt: null,
		values: {},
		createdAt: now,
		updatedAt: now,
	};
}
