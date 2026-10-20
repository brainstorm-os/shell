/**
 * Serialize a set of tasks for the clipboard. Markdown checkbox lines
 * (`- [ ] name` / `- [x] name`) — the most portable format: pastes as a live
 * checklist into the Notes/Journal editors, stays readable as plain text, and
 * round-trips through any markdown surface. Used by the list's multi-select
 * copy (Mod+C). Order follows what the caller passes (the visible row order).
 */

import type { Task } from "../types/task";
import { CompletionState, completionStateOf } from "./task-status";

/** Won't do is closed (ticked) but never finished, so its name is struck
 *  through — the markdown reading of the checkbox's third face. */
function clipboardLine(task: Task): string {
	const state = completionStateOf(task);
	if (state === CompletionState.Done) return `- [x] ${task.name}`;
	if (state === CompletionState.WontDo) return `- [x] ~~${task.name}~~`;
	return `- [ ] ${task.name}`;
}

export function serializeTasksForClipboard(tasks: ReadonlyArray<Task>): string {
	return tasks.map(clipboardLine).join("\n");
}
