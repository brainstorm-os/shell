/**
 * The Tasks write gate — Lock-5(i).
 *
 * Tasks had five `task.locked` reads and none of them was enforcement: the
 * board card dropped its drag affordance, the property cells handed back no
 * persisters, the ⋯ hid a row. Underneath, `saveTask` / `deleteTaskRecord` —
 * reached by ~20 callers, including a whole-list reorder that rewrites EVERY
 * task — wrote a locked task like any other.
 *
 * These tests drive the real funnels and assert on the sink: a refusal means
 * the repository never saw the write. Delete a guard and the write lands.
 */

import { describe, expect, it, vi } from "vitest";
import { type Task, TaskStatus } from "../types/task";
import {
	type TaskWriteContext,
	patchTaskWrite,
	removeTaskWrite,
	saveTaskWrite,
	taskLocked,
	toggleTaskLock,
} from "./task-writes";

function task(id: string, over: Partial<Task> = {}): Task {
	return {
		id,
		name: id,
		statusKey: TaskStatus.Todo,
		priority: null,
		scheduledAt: null,
		dueAt: null,
		completedAt: null,
		projectId: null,
		parentId: null,
		assigneeId: null,
		sortIndex: 0,
		values: {},
		createdAt: 1,
		updatedAt: 1,
		...over,
	} as Task;
}

function ctx(list: Task[]): TaskWriteContext & {
	save: ReturnType<typeof vi.fn>;
	remove: ReturnType<typeof vi.fn>;
} {
	const save = vi.fn();
	const remove = vi.fn();
	return { find: (id) => list.find((x) => x.id === id), sink: { save, remove }, save, remove };
}

describe("taskLocked", () => {
	it("reads the STORED lock, never the caller's copy of the row", () => {
		const c = ctx([task("t1", { locked: true })]);
		expect(taskLocked(c, "t1")).toBe(true);
		// A caller handing back a row with `locked: false` does not unlock it.
		expect(saveTaskWrite(c, task("t1", { locked: false, name: "sneaky" }))).toBe(false);
		expect(c.save).not.toHaveBeenCalled();
	});
});

describe("saveTaskWrite", () => {
	it("saves an unlocked task", () => {
		const c = ctx([task("t1")]);
		expect(saveTaskWrite(c, task("t1", { name: "Renamed" }))).toBe(true);
		expect(c.save).toHaveBeenCalledWith(expect.objectContaining({ name: "Renamed" }));
	});

	it("refuses a whole-row save on a LOCKED task — the reorder path", () => {
		// `onReorderTasks` rewrites every task's `sortIndex` in a loop; a locked
		// task must sit that out rather than be quietly renumbered.
		const c = ctx([task("t1", { locked: true })]);
		expect(saveTaskWrite(c, task("t1", { locked: true, sortIndex: 7 }))).toBe(false);
		expect(c.save).not.toHaveBeenCalled();
	});

	it("still CREATES a task that is not in the list yet", () => {
		const c = ctx([task("t1", { locked: true })]);
		expect(saveTaskWrite(c, task("new"))).toBe(true);
		expect(c.save).toHaveBeenCalledWith(expect.objectContaining({ id: "new" }));
	});
});

describe("patchTaskWrite", () => {
	it("patches an unlocked task", () => {
		const c = ctx([task("t1")]);
		expect(patchTaskWrite(c, "t1", (t) => ({ ...t, priority: 1 as never }))).toBe(true);
		expect(c.save).toHaveBeenCalled();
	});

	it("refuses every field patch on a LOCKED task", () => {
		const c = ctx([task("t1", { locked: true })]);
		// The real cells, one by one: status, priority, schedule, due, project,
		// assignee, rename, icon, and the subtask re-parent.
		expect(patchTaskWrite(c, "t1", (t) => ({ ...t, statusKey: TaskStatus.Done }))).toBe(false);
		expect(patchTaskWrite(c, "t1", (t) => ({ ...t, dueAt: 5 }))).toBe(false);
		expect(patchTaskWrite(c, "t1", (t) => ({ ...t, projectId: "p" }))).toBe(false);
		expect(patchTaskWrite(c, "t1", (t) => ({ ...t, assigneeId: "a" }))).toBe(false);
		expect(patchTaskWrite(c, "t1", (t) => ({ ...t, name: "Renamed" }))).toBe(false);
		expect(c.save).not.toHaveBeenCalled();
	});

	it("cannot be talked past by a rewrite that clears the lock itself", () => {
		const c = ctx([task("t1", { locked: true })]);
		expect(patchTaskWrite(c, "t1", (t) => ({ ...t, locked: false, name: "sneaky" }))).toBe(false);
		expect(c.save).not.toHaveBeenCalled();
	});

	it("writes nothing for a missing task or a no-op rewrite", () => {
		const c = ctx([task("t1")]);
		expect(patchTaskWrite(c, "gone", (t) => t)).toBe(false);
		expect(patchTaskWrite(c, "t1", (t) => t)).toBe(false);
		expect(c.save).not.toHaveBeenCalled();
	});
});

describe("toggleTaskLock — the one write a locked task still takes", () => {
	it("unlocks a locked task, so a lock can always be undone", () => {
		const c = ctx([task("t1", { locked: true })]);
		expect(toggleTaskLock(c, "t1", 42)).toBe(true);
		expect(c.save).toHaveBeenCalledWith(
			expect.objectContaining({ id: "t1", locked: false, updatedAt: 42 }),
		);
	});

	it("locks an unlocked task, and writes nothing for a missing one", () => {
		const c = ctx([task("t1")]);
		expect(toggleTaskLock(c, "t1", 42)).toBe(true);
		expect(c.save).toHaveBeenCalledWith(expect.objectContaining({ locked: true }));
		expect(toggleTaskLock(c, "gone", 42)).toBe(false);
	});
});

describe("removeTaskWrite — delete is a write too", () => {
	it("removes an unlocked task", () => {
		const c = ctx([task("t1")]);
		expect(removeTaskWrite(c, "t1")).toBe(true);
		expect(c.remove).toHaveBeenCalledWith("t1");
	});

	it("refuses to remove a LOCKED task", () => {
		const c = ctx([task("t1", { locked: true })]);
		expect(removeTaskWrite(c, "t1")).toBe(false);
		expect(c.remove).not.toHaveBeenCalled();
	});
});
