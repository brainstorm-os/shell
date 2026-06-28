// @vitest-environment jsdom
/**
 * KBN-A-tasks (12.4): the task list is a vertical listbox driven by the
 * shared `@brainstorm/sdk/a11y` composite-keyboard binding. The roles +
 * roving tabindex are STAMPED by the binding (not hand-written here), the
 * cursor follows the inspected task, ArrowDown moves + selects the next
 * task (same as a row click), and Enter opens it (same as the row's open
 * action). `renderSearchView` is the flat-list surface — it shares the
 * exact `renderTaskList` the bucketed surfaces use, so one list is enough
 * to pin the binding's wiring.
 *
 * The list builds every row through the host-supplied `rowProps` builder
 * (the app's `rowPropsFor`), so list rows carry the same chip set as board
 * cards and in-place-patched rows — pinned below with the tag + assignee
 * chips.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Priority, type Task } from "../types/task";
import { type SearchViewProps, renderSearchView } from "./surface-view";
import type { TaskRowProps } from "./task-row";

function task(overrides: Partial<Task> & { id: string }): Task {
	return {
		name: overrides.id,
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

/** Mirror of the app's `rowPropsFor` for the harness — one builder per
 *  mount so handler spies are shared across rows. */
function rowPropsBuilder(rowOver: Partial<TaskRowProps>): (t: Task) => TaskRowProps {
	const shared = {
		now: 0,
		projectsById: new Map(),
		showProjectChip: true,
		onToggleComplete: vi.fn(),
		onPickIcon: vi.fn(),
		onPickPriority: vi.fn(),
		onPickDate: vi.fn(),
		onPickProject: vi.fn(),
		onRenameTask: vi.fn(),
		onOpenEdit: vi.fn(),
		onSelectTask: vi.fn(),
		objectMenuEnabled: false,
	};
	return (t) => ({ task: t, ...shared, ...rowOver });
}

function baseProps(rowOver: Partial<TaskRowProps> = {}): SearchViewProps {
	return {
		tasks: [task({ id: "a", name: "Alpha" }), task({ id: "b", name: "Bravo" })],
		query: "a",
		rowProps: rowPropsBuilder(rowOver),
	};
}

afterEach(() => document.body.replaceChildren());

function mount(rowOver: Partial<TaskRowProps> = {}): {
	list: HTMLElement;
	rows: NodeListOf<HTMLElement>;
} {
	const view = renderSearchView(baseProps(rowOver));
	document.body.appendChild(view);
	const list = view.querySelector<HTMLElement>(".tasks-section__list");
	if (!list) throw new Error("no task list");
	return { list, rows: list.querySelectorAll<HTMLElement>("[data-composite-index]") };
}

describe("renderSearchView — KBN-A task list", () => {
	it("stamps listbox roles from the binding (not hand-written)", () => {
		const { list, rows } = mount();
		expect(list.getAttribute("role")).toBe("listbox");
		expect(rows).toHaveLength(2);
		expect(rows[0]?.getAttribute("role")).toBe("option");
		expect(rows[1]?.getAttribute("role")).toBe("option");
	});

	it("roves real focus: the cursor row is the only tab stop", () => {
		const { rows } = mount({ selectedTaskId: "a" });
		expect(rows[0]?.tabIndex).toBe(0);
		expect(rows[1]?.tabIndex).toBe(-1);
	});

	it("seeds the cursor on the inspected task", () => {
		const { list, rows } = mount({ selectedTaskId: "b" });
		expect(rows[1]?.tabIndex).toBe(0);
		expect(rows[0]?.tabIndex).toBe(-1);
		expect(list.getAttribute("aria-orientation")).toBe("vertical");
	});

	it("ArrowDown moves the cursor and selects the next task", () => {
		const onSelectTask = vi.fn();
		const { list, rows } = mount({ selectedTaskId: "a", onSelectTask });
		list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		expect(onSelectTask).toHaveBeenCalledTimes(1);
		expect(onSelectTask.mock.calls[0]?.[0]?.id).toBe("b");
		expect(rows[1]?.tabIndex).toBe(0);
	});

	it("Enter opens the cursor task", () => {
		const onOpenEdit = vi.fn();
		const { list } = mount({ selectedTaskId: "b", onOpenEdit });
		list.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		expect(onOpenEdit).toHaveBeenCalledTimes(1);
		expect(onOpenEdit.mock.calls[0]?.[0]?.id).toBe("b");
	});

	it("rows carry the builder's chip extras (tags + assignee), like board cards", () => {
		const { rows } = mount({
			tags: [{ id: "t-urgent", label: "Urgent" }],
			assigneeName: "Mira Chen",
		});
		expect(rows[0]?.querySelector(".task-row__tag")?.textContent).toBe("Urgent");
		expect(rows[0]?.querySelector(".task-row__assignee")?.textContent).toBe("Mira Chen");
	});
});
