import { describe, expect, it } from "vitest";
import { Priority, type Task } from "../types/task";
import { serializeTasksForClipboard } from "./task-clipboard";

function task(name: string, completedAt: number | null): Task {
	return {
		id: name,
		name,
		completedAt,
		priority: Priority.None,
		scheduledAt: null,
		dueAt: null,
		projectId: null,
		assigneeId: null,
		parentId: null,
	} as Task;
}

describe("serializeTasksForClipboard", () => {
	it("renders markdown checkbox lines, ticked for completed tasks", () => {
		const text = serializeTasksForClipboard([
			task("Write spec", null),
			task("Ship it", 1700000000000),
		]);
		expect(text).toBe("- [ ] Write spec\n- [x] Ship it");
	});

	it("ticks and strikes a won't-do task", () => {
		const wont = { ...task("Drop it", null), statusKey: "cancelled" } as Task;
		expect(serializeTasksForClipboard([wont])).toBe("- [x] ~~Drop it~~");
	});

	it("preserves the order it is given", () => {
		const text = serializeTasksForClipboard([task("B", null), task("A", null)]);
		expect(text).toBe("- [ ] B\n- [ ] A");
	});

	it("is empty for no tasks", () => {
		expect(serializeTasksForClipboard([])).toBe("");
	});
});
