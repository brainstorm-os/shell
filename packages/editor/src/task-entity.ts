/**
 * The task facts the editor needs to render and toggle an inline task
 * (B11.24) — kept dependency-free so the mention node can read them without
 * importing the `/task` command module.
 */

export const TASK_ENTITY_TYPE = "brainstorm/Task/v1";

/** Marks the checkbox so click-to-open handlers on mention chips skip it. */
export const TASK_CHECK_ATTR = "data-bs-task-check";

/** The seeded `task-status` key the Tasks app treats as done. */
const TASK_STATUS_DONE = "done";

export function isTaskDone(properties: Readonly<Record<string, unknown>> | undefined): boolean {
	if (!properties) return false;
	return properties.completedAt != null || properties.statusKey === TASK_STATUS_DONE;
}

/** The completion patch — identical to the Tasks inline-task block's. */
export function taskCompletionPatch(
	done: boolean,
	now: number = Date.now(),
): Record<string, unknown> {
	return done
		? { statusKey: TASK_STATUS_DONE, completedAt: now }
		: { statusKey: null, completedAt: null };
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
