/**
 * @vitest-environment jsdom
 *
 * 9.14.17 — the three-state task checkbox: open → done → won't do → open.
 * Done stays `completedAt !== null`; won't do is the seeded Cancelled status
 * with no completion stamp. Pins the pure model, its effect on the list
 * surfaces (won't-do is "closed": hidden by default, sunk below open work,
 * never overdue, never a blocker), the row's tri-state ARIA, and the
 * explicit menu picks.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskSurface } from "../types/surface";
import { Priority, type Task, TaskStatus } from "../types/task";
import { completionMenuItems } from "../ui/completion-menu";
import { renderTaskRow } from "../ui/task-row";
import { compileSurface } from "./compile-surface";
import { blockingTasks } from "./task-dependencies";
import {
	CompletionState,
	completionStateOf,
	isClosed,
	isOverdue,
	nextCompletionState,
	withCompletionState,
} from "./task-status";

function task(overrides: Partial<Task> = {}): Task {
	return {
		id: "task-1",
		name: "Buy milk",
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

afterEach(() => {
	document.body.replaceChildren();
});

describe("completion model", () => {
	it("reads done from completedAt and won't do from the Cancelled status", () => {
		expect(completionStateOf(task())).toBe(CompletionState.Open);
		expect(completionStateOf(task({ completedAt: 5 }))).toBe(CompletionState.Done);
		expect(completionStateOf(task({ statusKey: TaskStatus.Cancelled }))).toBe(CompletionState.WontDo);
		expect(isClosed(task({ statusKey: TaskStatus.Cancelled }))).toBe(true);
		expect(isClosed(task({ statusKey: TaskStatus.InProgress }))).toBe(false);
	});

	it("cycles open → done → won't do → open", () => {
		expect(nextCompletionState(CompletionState.Open)).toBe(CompletionState.Done);
		expect(nextCompletionState(CompletionState.Done)).toBe(CompletionState.WontDo);
		expect(nextCompletionState(CompletionState.WontDo)).toBe(CompletionState.Open);
	});

	it("applies each state with a matching status key and never stamps won't do as completed", () => {
		const open = task({ statusKey: TaskStatus.InProgress });
		const done = withCompletionState(open, CompletionState.Done, 100);
		expect(done).toMatchObject({ completedAt: 100, statusKey: TaskStatus.Done, updatedAt: 100 });
		const wontDo = withCompletionState(done, CompletionState.WontDo, 200);
		expect(wontDo).toMatchObject({ completedAt: null, statusKey: TaskStatus.Cancelled });
		const reopened = withCompletionState(wontDo, CompletionState.Open, 300);
		expect(reopened).toMatchObject({ completedAt: null, statusKey: null });
	});

	it("reopening keeps a non-terminal status and an unchanged state is a no-op", () => {
		const inProgress = task({ statusKey: TaskStatus.InProgress });
		expect(withCompletionState(inProgress, CompletionState.Open, 9)).toBe(inProgress);
	});
});

describe("won't do is closed on every surface", () => {
	const NOW = new Date(2026, 9, 18, 12).getTime();

	it("is hidden by default, shown (below open work) with showCompleted", () => {
		const tasks = [
			task({ id: "skip", name: "Skip", statusKey: TaskStatus.Cancelled, updatedAt: NOW }),
			task({ id: "todo", name: "Todo" }),
		];
		const hidden = compileSurface(tasks, TaskSurface.Inbox, { now: NOW });
		expect(hidden.sections.flatMap((s) => s.tasks.map((t) => t.id))).toEqual(["todo"]);
		const shown = compileSurface(tasks, TaskSurface.Inbox, { now: NOW, showCompleted: true });
		expect(shown.sections.flatMap((s) => s.tasks.map((t) => t.id))).toEqual(["todo", "skip"]);
	});

	it("is never overdue and never blocks a dependent", () => {
		const skipped = task({ id: "dep", statusKey: TaskStatus.Cancelled, dueAt: NOW - 1000 });
		expect(isOverdue(skipped, NOW)).toBe(false);
		const dependent = task({ id: "after", dependsOn: ["dep"] });
		expect(blockingTasks(dependent, new Map([["dep", skipped]]))).toEqual([]);
	});
});

describe("row checkbox", () => {
	function mountRow(t: Task) {
		const onToggleComplete = vi.fn();
		const row = renderTaskRow({
			task: t,
			now: 0,
			projectsById: new Map(),
			showProjectChip: true,
			onToggleComplete,
			onPickIcon: vi.fn(),
			onRenameTask: vi.fn(),
			onOpenEdit: vi.fn(),
			onSelectTask: vi.fn(),
			objectMenuEnabled: false,
		});
		document.body.appendChild(row);
		const toggle = row.querySelector<HTMLButtonElement>(".task-row__toggle");
		if (!toggle) throw new Error("no toggle");
		return { row, toggle, onToggleComplete };
	}

	it("exposes a tri-state checkbox: unchecked / checked / mixed, each with a state-naming label", () => {
		const open = mountRow(task());
		expect(open.toggle.getAttribute("role")).toBe("checkbox");
		expect(open.toggle.getAttribute("aria-checked")).toBe("false");
		expect(open.toggle.getAttribute("aria-label")).toBe("Mark “Buy milk” done");

		const done = mountRow(task({ completedAt: 1 }));
		expect(done.toggle.getAttribute("aria-checked")).toBe("true");
		expect(done.row.dataset.done).toBe("true");

		const wontDo = mountRow(task({ statusKey: TaskStatus.Cancelled }));
		expect(wontDo.toggle.getAttribute("aria-checked")).toBe("mixed");
		expect(wontDo.toggle.dataset.completion).toBe(CompletionState.WontDo);
		expect(wontDo.row.dataset.completion).toBe(CompletionState.WontDo);
		expect(wontDo.row.dataset.done).toBe("false");
		expect(wontDo.toggle.getAttribute("aria-label")).toBe("“Buy milk” won’t be done — reopen");
	});

	it("clicking the toggle hands the task to the cycle handler without selecting the row", () => {
		const { toggle, onToggleComplete } = mountRow(task());
		toggle.click();
		expect(onToggleComplete).toHaveBeenCalledOnce();
	});
});

describe("completion menu items", () => {
	it("offers the two states the task is not in, each declared as a write", () => {
		const set = vi.fn();
		const items = completionMenuItems(task({ completedAt: 1 }), set);
		expect(items.map((i) => i.id)).toEqual(["mark-wont-do", "reopen"]);
		expect(items.every((i) => i.writes)).toBe(true);
		void items[0]?.run();
		expect(set).toHaveBeenCalledWith(
			expect.objectContaining({ id: "task-1" }),
			CompletionState.WontDo,
		);
	});
});
