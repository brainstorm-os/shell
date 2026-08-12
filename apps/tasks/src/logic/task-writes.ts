/**
 * The ONE write path onto a `Task/v1` row — Lock-5(i).
 *
 * Tasks read `task.locked` in five places and every one of them was chrome or
 * a single call site: the board card dropped its drag affordance, the property
 * cells handed back no persisters, the ⋯ hid a row. The funnel underneath —
 * `saveTask` / `deleteTaskRecord`, reached by roughly twenty callers including
 * the whole-list reorder that rewrites EVERY task — had no gate. A locked task
 * was reordered, deleted and re-parented like any other.
 *
 * So the decision lives here, once, over the shared `entity-lock` reading, and
 * the gate is INSEPARABLE from the write: every function below both decides and
 * issues. Pure apart from the injected sink.
 */

import { lockRefusesWrite, lockTogglePatch } from "@brainstorm-os/sdk/entity-lock";
import type { Task } from "../types/task";

/** Where a permitted write goes: the repository under the shell, the in-memory
 *  demo snapshot standalone. Both spellings implement this. */
export type TaskWriteSink = {
	save(task: Task): void;
	remove(id: string): void;
};

/** Built fresh per call (from refs) so a callback that outlives its render —
 *  a drag commit, a dialog, a confirm — reads the CURRENT lock. */
export type TaskWriteContext = {
	find: (id: string) => Task | undefined;
	sink: TaskWriteSink;
};

/** The current stored lock for `id`. Read at write time, never from the
 *  caller's copy of the row — which may have flipped `locked` itself. */
export function taskLocked(ctx: Pick<TaskWriteContext, "find">, id: string): boolean {
	return ctx.find(id)?.locked === true;
}

/**
 * Save a whole task row, or refuse. `next` is a replacement row, so there is
 * no lock-only patch to earn the exemption with — `toggleTaskLock` is the one
 * door left open. A task not yet in the list is a CREATION: it has no stored
 * lock to honour, and refusing it would break "add task".
 */
export function saveTaskWrite(ctx: TaskWriteContext, next: Task): boolean {
	if (lockRefusesWrite(taskLocked(ctx, next.id))) return false;
	ctx.sink.save(next);
	return true;
}

/** Rewrite an existing task through `fn`, or refuse — the shape most callers
 *  want (patch a field off the current row). */
export function patchTaskWrite(
	ctx: TaskWriteContext,
	id: string,
	fn: (task: Task) => Task,
): boolean {
	const existing = ctx.find(id);
	if (!existing) return false;
	if (lockRefusesWrite(taskLocked(ctx, id))) return false;
	const next = fn(existing);
	if (next === existing) return false;
	ctx.sink.save(next);
	return true;
}

/** Flip a task's lock — the one write a locked task still takes. It goes
 *  through the SAME reading carrying the lock-only patch, not around it. */
export function toggleTaskLock(ctx: TaskWriteContext, id: string, now: number): boolean {
	const existing = ctx.find(id);
	if (!existing) return false;
	const patch = lockTogglePatch(existing.locked === true);
	if (lockRefusesWrite(existing.locked === true, patch)) return false;
	ctx.sink.save({ ...existing, ...patch, updatedAt: now });
	return true;
}

/** Delete a task, or refuse. Delete carries no patch to exempt, so a locked
 *  task refuses it outright — the chord and the confirm cannot walk around it. */
export function removeTaskWrite(ctx: TaskWriteContext, id: string): boolean {
	if (lockRefusesWrite(taskLocked(ctx, id))) return false;
	ctx.sink.remove(id);
	return true;
}
