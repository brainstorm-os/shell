/**
 * @vitest-environment jsdom
 *
 * Inline-edit affordances on the task row. The user complaint that
 * motivated this iteration: chips and name were read-only, so the app
 * felt like a flat todo list. These tests pin the click → callback wires
 * for each chip + the click-to-rename flow, so a future refactor can't
 * regress back to "you can only check off tasks".
 */

import { RecurrenceKind } from "@brainstorm/sdk-types";
import { SelectionModifier } from "@brainstorm/sdk/selection";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../types/project";
import { Priority, type Task } from "../types/task";
import { type TaskRowProps, renderTaskRow } from "./task-row";

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

function project(id: string, overrides: Partial<Project> = {}): Project {
	return {
		id,
		name: `Project ${id}`,
		statusKey: null,
		milestoneAt: null,
		colorHint: null,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	};
}

function mount(
	task: Task,
	overrides: Partial<TaskRowProps> = {},
): {
	row: HTMLLIElement;
	props: TaskRowProps;
} {
	const props: TaskRowProps = {
		task,
		now: 0,
		projectsById: new Map(),
		showProjectChip: true,
		onToggleComplete: vi.fn(),
		onPickIcon: vi.fn(),
		onRenameTask: vi.fn(),
		onOpenEdit: vi.fn(),
		onSelectTask: vi.fn(),
		objectMenuEnabled: true,
		...overrides,
	};
	const row = renderTaskRow(props);
	document.body.appendChild(row);
	return { row, props };
}

afterEach(() => {
	document.body.replaceChildren();
});

describe("overdue treatment", () => {
	const NOW = new Date(2026, 5, 20, 10, 0, 0, 0).getTime(); // 2026-06-20 10:00 local
	const DAY = 86_400_000;

	it("an open task scheduled for a past day reads as overdue (red chip), matching the Today Overdue section", () => {
		const { row } = mount(task({ scheduledAt: NOW - 3 * DAY }), { now: NOW });
		expect(row.dataset.overdue).toBe("true");
		expect(row.querySelector('.task-row__chip[data-kind="date-overdue"]')).not.toBeNull();
	});

	it("a task scheduled earlier today is NOT overdue", () => {
		const { row } = mount(task({ scheduledAt: NOW - 2 * 3_600_000 }), { now: NOW });
		expect(row.dataset.overdue).toBe("false");
		expect(row.querySelector('.task-row__chip[data-kind="date"]')).not.toBeNull();
	});

	it("a completed task scheduled in the past is never overdue", () => {
		const { row } = mount(task({ scheduledAt: NOW - 3 * DAY, completedAt: NOW - DAY }), { now: NOW });
		expect(row.dataset.overdue).toBe("false");
	});
});

describe("glance-only chips", () => {
	it("renders a glance-only priority chip (no click handler) when set", () => {
		const { row } = mount(task({ priority: Priority.High }));
		const chip = row.querySelector<HTMLElement>('.task-row__chip[data-kind="priority"]');
		expect(chip).not.toBeNull();
		expect(chip?.tagName).toBe("SPAN");
		expect(chip?.dataset.value).toBe(Priority.High);
	});

	it("omits the priority chip when priority is None", () => {
		const { row } = mount(task({ priority: Priority.None }));
		expect(row.querySelector('.task-row__chip[data-kind="priority"]')).toBeNull();
	});

	it("omits the date chip when no dates set", () => {
		const { row } = mount(task());
		expect(row.querySelector('.task-row__chip[data-kind="date"]')).toBeNull();
	});

	it("renders a glance-only date chip when a date is set", () => {
		const { row } = mount(task({ dueAt: 1234 }));
		const chip = row.querySelector<HTMLElement>('.task-row__chip[data-kind^="date"]');
		expect(chip).not.toBeNull();
		expect(chip?.tagName).toBe("SPAN");
	});

	it("due and scheduled chips share ONE visible format (bare date); semantics live in tooltip + sr-only text", () => {
		const NOW = new Date(2026, 5, 20, 10, 0, 0, 0).getTime();
		const JUN_27 = new Date(2026, 5, 27, 9, 0, 0, 0).getTime();
		const chipOf = (row: HTMLElement) =>
			row.querySelector<HTMLElement>('.task-row__chip[data-kind^="date"]');
		const visibleTextOf = (chip: HTMLElement | null | undefined) =>
			chip?.querySelector('[aria-hidden="true"]')?.textContent;

		const due = chipOf(mount(task({ dueAt: JUN_27 }), { now: NOW }).row);
		const scheduled = chipOf(mount(task({ id: "task-2", scheduledAt: JUN_27 }), { now: NOW }).row);

		// Same visible text — no "Due " prefix on one and a bare date on the other.
		expect(visibleTextOf(due)).toBe(visibleTextOf(scheduled));
		expect(visibleTextOf(due)).not.toContain("Due");
		// The due-vs-scheduled distinction is REAL (visually-hidden) text, so
		// screen readers announce it — NOT an aria-label, which ARIA prohibits
		// on a generic-role <span> and screen readers ignore in browse mode.
		expect(due?.getAttribute("aria-label")).toBeNull();
		const srDue = due?.querySelector(".tasks-sr-only");
		const srScheduled = scheduled?.querySelector(".tasks-sr-only");
		expect(srDue?.textContent).toBe(`Due ${visibleTextOf(due)}`);
		expect(srScheduled?.textContent).toBe(`Scheduled ${visibleTextOf(scheduled)}`);
		// The visible bare date is aria-hidden so the date isn't announced twice
		// (the sr-only phrase already contains it).
		expect(due?.querySelector('[aria-hidden="true"]')?.textContent).not.toContain("Due");
		// Tooltip keeps the full phrase for mouse users.
		expect(due?.title).toBe(`Due ${visibleTextOf(due)}`);
		expect(scheduled?.title).toBe(`Scheduled ${visibleTextOf(scheduled)}`);
	});

	it("recurrence chip announces the summary via sr-only text; the ↻ glyph is aria-hidden", () => {
		const { row } = mount(task({ recurrence: { kind: RecurrenceKind.Daily, every: 1 } }));
		const chip = row.querySelector<HTMLElement>('.task-row__chip[data-kind="recurring"]');
		expect(chip).not.toBeNull();
		// Real hidden text, not aria-label — ARIA prohibits naming a
		// generic-role span, so screen readers would ignore an aria-label.
		expect(chip?.getAttribute("aria-label")).toBeNull();
		expect(chip?.querySelector(".tasks-sr-only")?.textContent).toBe("Every day");
		// The glyph reads as garbage or nothing — hide it from AT.
		const glyph = chip?.querySelector('[aria-hidden="true"]');
		expect(glyph?.textContent).toBe("↻");
		// Tooltip keeps the summary for mouse users.
		expect(chip?.title).toBe("Every day");
	});

	it("omits the project chip when projectId is null", () => {
		const { row } = mount(task());
		expect(row.querySelector('.task-row__chip[data-kind="project"]')).toBeNull();
	});

	it("project chip renders the project name when populated", () => {
		const proj = project("proj-a", { name: "Garden" });
		const { row } = mount(task({ projectId: "proj-a" }), {
			projectsById: new Map([["proj-a", proj]]),
		});
		const chip = row.querySelector<HTMLElement>('.task-row__chip[data-kind="project"]');
		expect(chip?.textContent).toBe("Garden");
	});

	it("hides the project chip when showProjectChip is false", () => {
		const proj = project("proj-a", { name: "Garden" });
		const { row } = mount(task({ projectId: "proj-a" }), {
			showProjectChip: false,
			projectsById: new Map([["proj-a", proj]]),
		});
		expect(row.querySelector('.task-row__chip[data-kind="project"]')).toBeNull();
	});

	it("renders the project name in its own ellipsis span with a full-name title", () => {
		const long = "Cross-cutting tracks (Help, Net broker, NAPI, OpenRes, Feedback, Welcome, …)";
		const proj = project("proj-a", { name: long });
		const { row } = mount(task({ projectId: "proj-a" }), {
			projectsById: new Map([["proj-a", proj]]),
		});
		const chip = row.querySelector<HTMLElement>('.task-row__chip[data-kind="project"]');
		expect(chip?.querySelector(".task-row__chip-text")?.textContent).toBe(long);
		expect(chip?.title).toBe(long);
	});
});

describe("date chip suppression in date-grouped sections", () => {
	const JUN_23 = new Date(2026, 5, 23, 9, 0, 0).getTime();
	const JUN_24 = new Date(2026, 5, 24, 9, 0, 0).getTime();

	function dateChipOf(row: HTMLElement): HTMLButtonElement | null {
		return row.querySelector<HTMLButtonElement>('.task-row__chip[data-kind^="date"]');
	}

	it("suppresses the date chip when the row's date matches the section day", () => {
		const { row } = mount(task({ dueAt: JUN_23 }), { sectionDateKey: "2026-06-23" });
		expect(dateChipOf(row)).toBeNull();
	});

	it("keeps the date chip when the due date diverges from the section day", () => {
		const { row } = mount(task({ scheduledAt: JUN_23, dueAt: JUN_24 }), {
			sectionDateKey: "2026-06-23",
		});
		expect(dateChipOf(row)?.textContent).toContain("Jun 24");
	});

	it("keeps the date chip when no sectionDateKey is supplied", () => {
		const { row } = mount(task({ dueAt: JUN_23 }));
		expect(dateChipOf(row)).not.toBeNull();
	});
});

describe("row selection → inspector", () => {
	it("clicking the row body fires onSelectTask with a plain (None) modifier", () => {
		const { row, props } = mount(task());
		row.querySelector<HTMLElement>(".task-row__body")?.click();
		expect(props.onSelectTask).toHaveBeenCalledTimes(1);
		expect(props.onSelectTask).toHaveBeenCalledWith(
			expect.objectContaining({ id: "task-1" }),
			SelectionModifier.None,
		);
	});

	it("Cmd/Ctrl-clicking the row body fires onSelectTask with the Toggle modifier", () => {
		const { row, props } = mount(task());
		const body = row.querySelector<HTMLElement>(".task-row__body");
		body?.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
		expect(props.onSelectTask).toHaveBeenCalledWith(
			expect.objectContaining({ id: "task-1" }),
			SelectionModifier.Toggle,
		);
	});

	it("clicking the name label selects the row (does not enter rename)", () => {
		const { row, props } = mount(task({ name: "Original" }));
		row.querySelector<HTMLButtonElement>(".task-row__name-label")?.click();
		expect(props.onSelectTask).toHaveBeenCalledTimes(1);
		expect(row.querySelector(".task-row__name-input")).toBeNull();
	});

	it("clicking the toggle does NOT select the row", () => {
		const { row, props } = mount(task());
		row.querySelector<HTMLButtonElement>(".task-row__toggle")?.click();
		expect(props.onToggleComplete).toHaveBeenCalledTimes(1);
		expect(props.onSelectTask).not.toHaveBeenCalled();
	});

	it("glance chips are display-only spans (not interactive buttons)", () => {
		const { row } = mount(task({ priority: Priority.High }));
		const chip = row.querySelector<HTMLElement>('.task-row__chip[data-kind="priority"]');
		expect(chip?.tagName).toBe("SPAN");
	});

	it("reflects the selected task via data-selected", () => {
		const selected = mount(task(), { selectedTaskId: "task-1" });
		expect(selected.row.dataset.selected).toBe("true");
		const other = mount(task(), { selectedTaskId: "task-other" });
		expect(other.row.dataset.selected).toBe("false");
	});
});

describe("inline rename (double-click)", () => {
	function requireInput(row: Element): HTMLInputElement {
		const input = row.querySelector<HTMLInputElement>(".task-row__name-input");
		if (!input) throw new Error("expected rename input to be mounted");
		return input;
	}

	function enterRename(row: HTMLElement): void {
		row
			.querySelector<HTMLElement>(".task-row__name")
			?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
	}

	it("double-click on the name swaps in an input prefilled + selected", () => {
		const { row } = mount(task({ name: "Original" }));
		enterRename(row);
		const input = row.querySelector<HTMLInputElement>(".task-row__name-input");
		expect(input).not.toBeNull();
		expect(input?.value).toBe("Original");
	});

	it("Enter commits the trimmed value and calls onRenameTask once", () => {
		const { row, props } = mount(task({ name: "Old" }));
		enterRename(row);
		const input = requireInput(row);
		input.value = "  New name  ";
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		expect(props.onRenameTask).toHaveBeenCalledTimes(1);
		expect(props.onRenameTask).toHaveBeenCalledWith(
			expect.objectContaining({ id: "task-1" }),
			"New name",
		);
	});

	it("Escape cancels without firing onRenameTask", () => {
		const { row, props } = mount(task({ name: "Old" }));
		enterRename(row);
		const input = requireInput(row);
		input.value = "Never";
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(props.onRenameTask).not.toHaveBeenCalled();
		expect(row.querySelector(".task-row__name-input")).toBeNull();
	});

	it("blur commits, but unchanged value does not fire onRenameTask", () => {
		const { row, props } = mount(task({ name: "Same" }));
		enterRename(row);
		const input = requireInput(row);
		input.dispatchEvent(new Event("blur"));
		expect(props.onRenameTask).not.toHaveBeenCalled();
	});
});

describe("renderTaskRow — subtask progress badge (9.14.7)", () => {
	it("renders an n/m badge when the task has subtasks", () => {
		const { row } = mount(task(), { subtaskCount: { done: 1, total: 3 } });
		const badge = row.querySelector(".task-row__subtasks");
		expect(badge).not.toBeNull();
		expect(badge?.textContent).toContain("1/3");
		expect((badge as HTMLElement)?.dataset.complete).toBeUndefined();
	});

	it("marks the badge complete when all subtasks are done", () => {
		const { row } = mount(task(), { subtaskCount: { done: 2, total: 2 } });
		expect((row.querySelector(".task-row__subtasks") as HTMLElement)?.dataset.complete).toBe("true");
	});

	it("renders no badge for a leaf task (no subtasks)", () => {
		expect(
			mount(task(), { subtaskCount: { done: 0, total: 0 } }).row.querySelector(".task-row__subtasks"),
		).toBeNull();
		expect(mount(task()).row.querySelector(".task-row__subtasks")).toBeNull();
	});
});

describe("renderTaskRow — blocked flag (9.14.8)", () => {
	it("renders a Blocked flag when blocked", () => {
		const { row } = mount(task(), { blocked: true });
		expect(row.querySelector(".task-row__blocked")).not.toBeNull();
	});

	it("renders no flag when not blocked", () => {
		expect(mount(task(), { blocked: false }).row.querySelector(".task-row__blocked")).toBeNull();
		expect(mount(task()).row.querySelector(".task-row__blocked")).toBeNull();
	});
});

describe("renderTaskRow — time chip (9.14.13)", () => {
	it("shows logged / estimate when both set", () => {
		const { row } = mount(task(), { estimateMinutes: 240, loggedMinutes: 60 });
		const chip = row.querySelector(".task-row__time");
		expect(chip?.textContent).toBe("1h / 4h");
		expect((chip as HTMLElement)?.dataset.over).toBeUndefined();
	});

	it("shows just the estimate when nothing logged, and flags over-budget", () => {
		expect(
			mount(task(), { estimateMinutes: 120 }).row.querySelector(".task-row__time")?.textContent,
		).toBe("2h");
		const over = mount(task(), { estimateMinutes: 60, loggedMinutes: 90 }).row.querySelector(
			".task-row__time",
		);
		expect((over as HTMLElement)?.dataset.over).toBe("true");
	});

	it("renders no time chip without an estimate", () => {
		expect(mount(task()).row.querySelector(".task-row__time")).toBeNull();
		expect(mount(task(), { loggedMinutes: 30 }).row.querySelector(".task-row__time")).toBeNull();
	});
});

describe("renderTaskRow — tag chips (9.14.10)", () => {
	it("renders a chip per tag (by label) and clicking fires onClickTag with the id", () => {
		const onClickTag = vi.fn();
		const { row } = mount(task(), {
			tags: [
				{ id: "t-urgent", label: "Urgent" },
				{ id: "t-later", label: "Later" },
			],
			onClickTag,
		});
		const chips = [...row.querySelectorAll(".task-row__tag")].map((c) => c.textContent);
		expect(chips).toEqual(["Urgent", "Later"]);
		(row.querySelector(".task-row__tag") as HTMLButtonElement).click();
		expect(onClickTag).toHaveBeenCalledWith("t-urgent");
	});

	it("renders no chips without tags", () => {
		expect(mount(task()).row.querySelector(".task-row__tag")).toBeNull();
	});
});

describe("renderTaskRow — assignee chip (9.14.15)", () => {
	it("renders the resolved assignee name as a display chip", () => {
		const { row } = mount(task({ assigneeId: "person-1" }), { assigneeName: "Mira Chen" });
		const chip = row.querySelector(".task-row__assignee");
		expect(chip?.textContent).toBe("Mira Chen");
		expect(chip?.getAttribute("title")).toContain("Mira Chen");
	});

	it("renders no chip when unassigned", () => {
		expect(mount(task()).row.querySelector(".task-row__assignee")).toBeNull();
	});
});
