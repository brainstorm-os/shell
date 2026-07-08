// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { BoardColumn } from "../logic/compile-board";
import { Priority, type Task, TaskStatus } from "../types/task";
import { renderBoardView } from "./board-view";

const CARD_MIME = "application/x-brainstorm-task-card";

function task(id: string, statusKey: string | null = null): Task {
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
		statusKey,
		createdAt: 0,
		updatedAt: 0,
	};
}

function columns(): BoardColumn[] {
	return [
		{
			key: TaskStatus.Todo,
			tasks: [task("t1", TaskStatus.Todo), task("t2", TaskStatus.Todo), task("n1")],
		},
		{ key: TaskStatus.InProgress, tasks: [task("p1", TaskStatus.InProgress)] },
		{ key: TaskStatus.Done, tasks: [] },
	];
}

type MoveMock = ReturnType<typeof vi.fn<(taskId: string, statusKey: string) => void>>;
type AddMock = ReturnType<typeof vi.fn<(name: string, statusKey: string) => void>>;

function mount(opts: { onMoveToStatus?: MoveMock; onAddTask?: AddMock } = {}) {
	const onMoveToStatus = opts.onMoveToStatus ?? vi.fn<(taskId: string, statusKey: string) => void>();
	const board = renderBoardView({
		columns: columns(),
		labelFor: (key) => key,
		renderCard: (t) => {
			const el = document.createElement("div");
			el.className = "card-body";
			el.textContent = t.name;
			return el;
		},
		onMoveToStatus,
		...(opts.onAddTask ? { onAddTask: opts.onAddTask } : {}),
	});
	document.body.appendChild(board);
	return { board, onMoveToStatus };
}

describe("renderBoardView", () => {
	it("renders a column per BoardColumn with label + count", () => {
		const { board } = mount();
		const cols = board.querySelectorAll(".tasks-board__column");
		expect(cols).toHaveLength(3);
		expect(cols[0]?.querySelector(".tasks-board__column-label")?.textContent).toBe(TaskStatus.Todo);
		expect(cols[0]?.querySelector(".tasks-board__column-count")?.textContent).toBe("3");
		expect((cols[0] as HTMLElement)?.dataset.statusKey).toBe(TaskStatus.Todo);
	});

	it("renders the app card body per task and an empty hint for empty columns", () => {
		const { board } = mount();
		const todo = board.querySelector(`[data-status-key="${TaskStatus.Todo}"]`);
		expect(todo?.querySelectorAll(".card-body")).toHaveLength(3);
		const done = board.querySelector(`[data-status-key="${TaskStatus.Done}"]`);
		expect(done?.querySelector(".tasks-board__empty")).not.toBeNull();
	});

	it("renders exactly one card per task (F-206 — no repeats)", () => {
		const { board } = mount();
		const ids = [...board.querySelectorAll<HTMLElement>(".tasks-board__card")].map(
			(c) => c.dataset.taskId,
		);
		expect(ids).toEqual(["t1", "t2", "n1", "p1"]);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("dropping a card on a column moves it to that status", () => {
		const { board, onMoveToStatus } = mount();
		const done = board.querySelector(`[data-status-key="${TaskStatus.Done}"]`) as HTMLElement;
		const data = new Map<string, string>([[CARD_MIME, "t1"]]);
		const dataTransfer = {
			types: [CARD_MIME],
			getData: (k: string) => data.get(k) ?? "",
			dropEffect: "",
		};
		const drop = new Event("drop", { bubbles: true });
		Object.defineProperty(drop, "dataTransfer", { value: dataTransfer });
		done.dispatchEvent(drop);
		expect(onMoveToStatus).toHaveBeenCalledWith("t1", TaskStatus.Done);
	});
});

describe("renderBoardView inline add (F-207)", () => {
	function submit(form: HTMLFormElement): void {
		form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
	}

	it("renders no add affordance without onAddTask (preview mode)", () => {
		const { board } = mount();
		expect(board.querySelector(".tasks-board__add")).toBeNull();
	});

	it("renders an add affordance per column; clicking swaps to a focused input", () => {
		const onAddTask: AddMock = vi.fn();
		const { board } = mount({ onAddTask });
		const adds = board.querySelectorAll(".tasks-board__add-button");
		expect(adds).toHaveLength(3);
		(adds[0] as HTMLButtonElement).click();
		const input = board.querySelector<HTMLInputElement>(".tasks-board__add-input");
		expect(input).not.toBeNull();
		expect(document.activeElement).toBe(input);
	});

	it("submitting a name creates the task with the column's status", async () => {
		const onAddTask: AddMock = vi.fn();
		const { board } = mount({ onAddTask });
		const inProgress = board.querySelector(
			`[data-status-key="${TaskStatus.InProgress}"]`,
		) as HTMLElement;
		inProgress.querySelector<HTMLButtonElement>(".tasks-board__add-button")?.click();
		const input = inProgress.querySelector<HTMLInputElement>(".tasks-board__add-input");
		const form = inProgress.querySelector<HTMLFormElement>(".tasks-board__add-form");
		if (!input || !form) throw new Error("add form not mounted");
		input.value = "  Ship the board fix  ";
		submit(form);
		// The form folds back to the button synchronously; the add is deferred
		// out of the blur/submit dispatch (F-254).
		expect(inProgress.querySelector(".tasks-board__add-form")).toBeNull();
		expect(inProgress.querySelector(".tasks-board__add-button")).not.toBeNull();
		await Promise.resolve();
		expect(onAddTask).toHaveBeenCalledWith("Ship the board fix", TaskStatus.InProgress);
	});

	it("an empty submit reverts without creating a task", () => {
		const onAddTask: AddMock = vi.fn();
		const { board } = mount({ onAddTask });
		const todo = board.querySelector(`[data-status-key="${TaskStatus.Todo}"]`) as HTMLElement;
		todo.querySelector<HTMLButtonElement>(".tasks-board__add-button")?.click();
		const form = todo.querySelector<HTMLFormElement>(".tasks-board__add-form");
		if (!form) throw new Error("add form not mounted");
		submit(form);
		expect(onAddTask).not.toHaveBeenCalled();
		expect(todo.querySelector(".tasks-board__add-button")).not.toBeNull();
	});

	it("Escape cancels without creating a task, even with text typed", () => {
		const onAddTask: AddMock = vi.fn();
		const { board } = mount({ onAddTask });
		const todo = board.querySelector(`[data-status-key="${TaskStatus.Todo}"]`) as HTMLElement;
		const button = todo.querySelector<HTMLButtonElement>(".tasks-board__add-button");
		button?.click();
		const input = todo.querySelector<HTMLInputElement>(".tasks-board__add-input");
		if (!input) throw new Error("add input not mounted");
		input.value = "Abandoned draft";
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(onAddTask).not.toHaveBeenCalled();
		expect(todo.querySelector(".tasks-board__add-form")).toBeNull();
		expect(todo.querySelector(".tasks-board__add-button")).not.toBeNull();
		// A blur fired by the form teardown must not resurrect the commit.
		input.dispatchEvent(new Event("blur"));
		expect(onAddTask).not.toHaveBeenCalled();
		// Focus returns to the add button so the keyboard path isn't dropped.
		expect(document.activeElement).toBe(button);
	});

	it("blur commits a non-empty name (same contract as inline rename)", async () => {
		const onAddTask: AddMock = vi.fn();
		const { board } = mount({ onAddTask });
		const todo = board.querySelector(`[data-status-key="${TaskStatus.Todo}"]`) as HTMLElement;
		todo.querySelector<HTMLButtonElement>(".tasks-board__add-button")?.click();
		const input = todo.querySelector<HTMLInputElement>(".tasks-board__add-input");
		if (!input) throw new Error("add input not mounted");
		input.value = "Captured on blur";
		input.dispatchEvent(new Event("blur"));
		await Promise.resolve();
		expect(onAddTask).toHaveBeenCalledWith("Captured on blur", TaskStatus.Todo);
	});
});

describe("renderBoardView keyboard (KBN-A-tasks)", () => {
	function mountKeyboard(selectedTaskId: string | null = "t1") {
		const onSelectTask = vi.fn();
		const onOpenEdit = vi.fn();
		const board = renderBoardView({
			columns: columns(),
			labelFor: (key) => key,
			renderCard: (t) => {
				const el = document.createElement("div");
				el.textContent = t.name;
				return el;
			},
			onMoveToStatus: vi.fn(),
			selectedTaskId,
			onSelectTask,
			onOpenEdit,
		});
		document.body.appendChild(board);
		return { board, onSelectTask, onOpenEdit };
	}

	function press(board: HTMLElement, key: string): void {
		board.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
	}

	it("stamps listbox on the board, group on columns, option + composite index on cards", () => {
		const { board } = mountKeyboard();
		expect(board.getAttribute("role")).toBe("listbox");
		expect(board.querySelector(".tasks-board__column")?.getAttribute("role")).toBe("group");
		const cards = [...board.querySelectorAll<HTMLElement>(".tasks-board__card")];
		// Four cards (t1, t2, n1, p1) across the two non-empty columns.
		expect(cards.map((c) => c.dataset.compositeIndex)).toEqual(["0", "1", "2", "3"]);
		expect(cards[0]?.getAttribute("role")).toBe("option");
	});

	it("arrows move spatially across columns/rows and Enter opens the focused card", () => {
		const { board, onSelectTask, onOpenEdit } = mountKeyboard("t1");
		// t1 is (col0,row0); Right → p1 (col1,row0).
		press(board, "ArrowRight");
		expect(onSelectTask).toHaveBeenLastCalledWith(expect.objectContaining({ id: "p1" }));
		// p1 is (col1,row0); Left then Down → t2 (col0,row1).
		press(board, "ArrowLeft");
		press(board, "ArrowDown");
		expect(onSelectTask).toHaveBeenLastCalledWith(expect.objectContaining({ id: "t2" }));
		// Enter opens the focused card for editing.
		press(board, "Enter");
		expect(onOpenEdit).toHaveBeenLastCalledWith(expect.objectContaining({ id: "t2" }));
	});

	it("no keyboard binding when the open/select callbacks are absent", () => {
		const { board } = mount();
		// Without onSelectTask/onOpenEdit the board stays a plain container.
		expect(board.getAttribute("role")).toBeNull();
		expect(board.querySelector(".tasks-board__card")?.hasAttribute("data-composite-index")).toBe(
			false,
		);
	});
});
