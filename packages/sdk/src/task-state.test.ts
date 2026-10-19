import { describe, expect, it } from "vitest";
import {
	isTaskClosed,
	isTaskDone,
	isTaskWontDo,
	reopenedStatusKey,
} from "./task-state";

describe("task-state", () => {
	it("reads done from a completion stamp or the done status", () => {
		expect(isTaskDone(undefined)).toBe(false);
		expect(isTaskDone({ completedAt: null, statusKey: null })).toBe(false);
		expect(isTaskDone({ completedAt: 5 })).toBe(true);
		expect(isTaskDone({ statusKey: "done" })).toBe(true);
		expect(isTaskDone({ completedAt: "5" })).toBe(false);
	});

	it("treats won't do as closed but not done", () => {
		const wontDo = { completedAt: null, statusKey: "cancelled" };
		expect(isTaskWontDo(wontDo)).toBe(true);
		expect(isTaskDone(wontDo)).toBe(false);
		expect(isTaskClosed(wontDo)).toBe(true);
	});

	it("leaves open, in-progress and custom statuses open", () => {
		expect(isTaskClosed({ completedAt: null, statusKey: "in-progress" })).toBe(false);
		expect(isTaskClosed({ completedAt: null, statusKey: "blocked-on-legal" })).toBe(false);
		expect(isTaskClosed(null)).toBe(false);
	});

	it("keeps a non-terminal status across a reopen", () => {
		expect(reopenedStatusKey("done")).toBeNull();
		expect(reopenedStatusKey("cancelled")).toBeNull();
		expect(reopenedStatusKey("in-progress")).toBe("in-progress");
		expect(reopenedStatusKey(null)).toBeNull();
		expect(reopenedStatusKey(3)).toBeNull();
	});
});
