import { describe, expect, it } from "vitest";
import { Priority, type Task } from "../types/task";
import { childrenOf, subtaskProgress, topLevelTasks, wouldCreateCycle } from "./subtask-tree";

function task(id: string, overrides: Partial<Task> = {}): Task {
	return {
		id,
		name: id,
		completedAt: null,
		priority: Priority.None,
		scheduledAt: null,
		dueAt: null,
		projectId: null,
		assigneeId: null,
		parentId: null,
		recurrence: null,
		statusKey: null,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

describe("subtask-tree", () => {
	const tasks = [
		task("p"),
		task("a", { parentId: "p", completedAt: 100 }),
		task("b", { parentId: "p" }),
		task("c", { parentId: "a" }), // grandchild
		task("solo"),
	];

	it("childrenOf returns direct children only, in order", () => {
		expect(childrenOf(tasks, "p").map((t) => t.id)).toEqual(["a", "b"]);
		expect(childrenOf(tasks, "a").map((t) => t.id)).toEqual(["c"]);
		expect(childrenOf(tasks, "solo")).toEqual([]);
	});

	it("topLevelTasks excludes children but surfaces orphans", () => {
		expect(topLevelTasks(tasks).map((t) => t.id)).toEqual(["p", "solo"]);
		const orphaned = [task("x", { parentId: "ghost" })];
		expect(topLevelTasks(orphaned).map((t) => t.id)).toEqual(["x"]);
	});

	it("subtaskProgress counts direct children's completion", () => {
		expect(subtaskProgress(tasks, "p")).toEqual({ done: 1, total: 2 });
		expect(subtaskProgress(tasks, "a")).toEqual({ done: 0, total: 1 });
		expect(subtaskProgress(tasks, "solo")).toEqual({ done: 0, total: 0 });
	});

	it("subtaskProgress counts a won't-do child as closed", () => {
		const kids = [
			task("q"),
			task("q1", { parentId: "q", completedAt: 5 }),
			task("q2", { parentId: "q", statusKey: "cancelled" }),
		];
		expect(subtaskProgress(kids, "q")).toEqual({ done: 2, total: 2 });
	});

	it("wouldCreateCycle rejects self, descendants, and grandchildren", () => {
		expect(wouldCreateCycle(tasks, "p", "p")).toBe(true); // self
		expect(wouldCreateCycle(tasks, "p", "a")).toBe(true); // direct child
		expect(wouldCreateCycle(tasks, "p", "c")).toBe(true); // grandchild
	});

	it("wouldCreateCycle allows an unrelated parent", () => {
		expect(wouldCreateCycle(tasks, "b", "solo")).toBe(false);
		expect(wouldCreateCycle(tasks, "solo", "p")).toBe(false);
	});

	it("wouldCreateCycle terminates on a pre-existing loop in malformed data", () => {
		const looped = [task("x", { parentId: "y" }), task("y", { parentId: "x" })];
		// Must return (not hang); x is reachable from y so assigning y under x cycles.
		expect(wouldCreateCycle(looped, "x", "y")).toBe(true);
	});
});
