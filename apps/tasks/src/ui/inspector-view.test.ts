/**
 * @vitest-environment jsdom
 *
 * Task detail route — the plain-DOM half: the title row (toggle + editable
 * title), the reused property chip strip, and the editor host slot. The live
 * `<BrainstormEditor>` mount is exercised by the real-shell Playwright spec
 * (jsdom can't mount `@lexical/yjs`). Closing the route is the header back
 * button's job, so the view has no close affordance of its own.
 */

import type { RecurrenceEditorLabels } from "@brainstorm/sdk/recurrence-editor";
import { buildRecurrenceLabels } from "@brainstorm/sdk/recurrence-labels";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Priority, type Task } from "../types/task";
import { renderLegacyNotesFallback, renderTaskDetailView } from "./inspector-view";

function task(overrides: Partial<Task> = {}): Task {
	return {
		id: "task-1",
		name: "Ship the detail route",
		completedAt: null,
		priority: Priority.High,
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

function mount(t: Task, over: Partial<Parameters<typeof renderTaskDetailView>[0]> = {}) {
	const props = {
		task: t,
		onToggleComplete: vi.fn(),
		onRenameTask: vi.fn(),
		...over,
	};
	const view = renderTaskDetailView(props);
	document.body.appendChild(view.root);
	return { view, props };
}

afterEach(() => document.body.replaceChildren());

describe("renderTaskDetailView", () => {
	it("renders a centered detail with the task name as the editable title", () => {
		const { view } = mount(task());
		expect(view.root.classList.contains("tasks-detail")).toBe(true);
		const label = view.root.querySelector(".task-row__name-label");
		expect(label?.textContent).toBe("Ship the detail route");
		expect(view.root.querySelector(".tasks-detail__title-group")).not.toBeNull();
	});

	it("exposes an empty property-cells host for the app to mount into", () => {
		const { view } = mount(task());
		expect(view.propertyHost).not.toBeNull();
		expect(view.propertyHost.children).toHaveLength(0);
		// The hand-rolled chips / tags / time sections are gone — properties are
		// edited through the shared cells mounted into propertyHost.
		expect(view.root.querySelector(".tasks-detail__chips")).toBeNull();
		expect(view.root.querySelector(".tasks-detail__tags")).toBeNull();
		expect(view.root.querySelector(".tasks-detail__time")).toBeNull();
	});

	it("the completion toggle fires onToggleComplete", () => {
		const { view, props } = mount(task());
		view.root.querySelector<HTMLButtonElement>(".task-row__toggle")?.click();
		expect(props.onToggleComplete).toHaveBeenCalledTimes(1);
	});

	it("has no in-view close affordance — the header back button closes it", () => {
		const { view } = mount(task());
		expect(view.root.querySelector(".tasks-inspector__close")).toBeNull();
	});

	it("exposes an empty editor host for the app to mount into", () => {
		const { view } = mount(task());
		expect(view.editorHost).not.toBeNull();
		expect(view.editorHost.children).toHaveLength(0);
	});
});

describe("renderTaskDetailView — subtasks (9.14.7)", () => {
	it("omits the Subtasks section when no subtask handlers are wired", () => {
		const { view } = mount(task());
		expect(view.root.querySelector(".tasks-detail__subtasks")).toBeNull();
	});

	it("lists children with a progress count and an add field", () => {
		const children = [
			task({ id: "c1", name: "Child one", completedAt: 10 }),
			task({ id: "c2", name: "Child two" }),
		];
		const { view } = mount(task(), {
			subtasks: children,
			onOpenSubtask: vi.fn(),
			onToggleSubtask: vi.fn(),
			onAddSubtask: vi.fn(),
		});
		const section = view.root.querySelector(".tasks-detail__subtasks");
		expect(section).not.toBeNull();
		expect(section?.querySelector(".tasks-detail__subtasks-count")?.textContent).toBe("1/2");
		const names = [...view.root.querySelectorAll(".tasks-detail__subtask-name")].map(
			(n) => n.textContent,
		);
		expect(names).toEqual(["Child one", "Child two"]);
		// The completed child is struck through via data-done.
		const doneRow = view.root.querySelector('.tasks-detail__subtask[data-task-id="c1"]');
		expect((doneRow as HTMLElement)?.dataset.done).toBe("true");
		expect(view.root.querySelector(".tasks-detail__subtask-add-input")).not.toBeNull();
	});

	it("opening a child fires onOpenSubtask with that child", () => {
		const onOpenSubtask = vi.fn();
		const { view } = mount(task(), {
			subtasks: [task({ id: "c1", name: "Child one" })],
			onOpenSubtask,
		});
		(view.root.querySelector(".tasks-detail__subtask-name") as HTMLButtonElement).click();
		expect(onOpenSubtask).toHaveBeenCalledWith(expect.objectContaining({ id: "c1" }));
	});

	it("submitting the add field fires onAddSubtask with the trimmed name and clears the input", () => {
		const onAddSubtask = vi.fn();
		const { view } = mount(task(), { subtasks: [], onAddSubtask });
		const input = view.root.querySelector(".tasks-detail__subtask-add-input") as HTMLInputElement;
		input.value = "  New child  ";
		(input.closest("form") as HTMLFormElement).requestSubmit();
		expect(onAddSubtask).toHaveBeenCalledWith("New child");
		expect(input.value).toBe("");
	});

	it("a blank add submission is a no-op", () => {
		const onAddSubtask = vi.fn();
		const { view } = mount(task(), { subtasks: [], onAddSubtask });
		const input = view.root.querySelector(".tasks-detail__subtask-add-input") as HTMLInputElement;
		input.value = "   ";
		(input.closest("form") as HTMLFormElement).requestSubmit();
		expect(onAddSubtask).not.toHaveBeenCalled();
	});
});

describe("renderTaskDetailView — blocked by (9.14.8)", () => {
	it("omits the Blocked-by section without dependency handlers", () => {
		const { view } = mount(task());
		expect(view.root.querySelector(".tasks-detail__blockedby")).toBeNull();
	});

	it("lists blockers with a Blocked flag and remove buttons", () => {
		const { view } = mount(task(), {
			blockedBy: [task({ id: "b1", name: "Blocker one" })],
			onOpenDependency: vi.fn(),
			onRemoveDependency: vi.fn(),
			onAddDependency: vi.fn(),
		});
		const section = view.root.querySelector(".tasks-detail__blockedby");
		expect(section).not.toBeNull();
		expect(section?.querySelector(".tasks-detail__blocked-flag")).not.toBeNull();
		expect(section?.querySelector(".tasks-detail__subtask-name")?.textContent).toBe("Blocker one");
		expect(section?.querySelector(".tasks-detail__dep-add")).not.toBeNull();
	});

	it("remove fires onRemoveDependency with the blocker id", () => {
		const onRemoveDependency = vi.fn();
		const { view } = mount(task(), {
			blockedBy: [task({ id: "b1", name: "Blocker one" })],
			onRemoveDependency,
		});
		(view.root.querySelector(".tasks-detail__dep-remove") as HTMLButtonElement).click();
		expect(onRemoveDependency).toHaveBeenCalledWith("b1");
	});

	it("the add button fires onAddDependency with its anchor element", () => {
		const onAddDependency = vi.fn();
		const { view } = mount(task(), { blockedBy: [], onAddDependency });
		const add = view.root.querySelector(".tasks-detail__dep-add") as HTMLButtonElement;
		add.click();
		expect(onAddDependency).toHaveBeenCalledWith(add);
	});
});

describe("renderTaskDetailView — recurrence (9.14.12)", () => {
	const editorLabels: RecurrenceEditorLabels = {
		fieldLabel: "Repeat",
		kind: {
			none: "None",
			daily: "Daily",
			weekly: "Weekly",
			monthly: "Monthly",
			yearly: "Yearly",
			custom: "Custom",
		},
		editEvery: "Every",
		unitDays: "days",
		unitWeeks: "weeks",
		unitMonths: "months",
		intervalLabel: "Interval",
		onDays: "On days",
		monthlyMode: "Mode",
		monthlyByDayLabel: "On day",
		monthlyByWeekdayLabel: "On the",
		yearlyMonth: "Month",
		yearlyDay: "Day",
		customLabel: "RRULE",
		customPlaceholder: "FREQ=WEEKLY",
	};
	const summaryLabels = buildRecurrenceLabels((key, params) =>
		params ? Object.values(params).join(" ") : key,
	);

	it("omits the Repeat section without a recurrence config", () => {
		const { view } = mount(task());
		expect(view.root.querySelector(".tasks-detail__recurrence")).toBeNull();
	});

	it("mounts the shared recurrence editor when configured", () => {
		const onChange = vi.fn();
		const { view } = mount(task(), {
			recurrence: { value: null, anchor: 0, labels: editorLabels, summaryLabels, onChange },
		});
		const section = view.root.querySelector(".tasks-detail__recurrence");
		expect(section).not.toBeNull();
		expect(section?.querySelector(".bs-recur__kind")).not.toBeNull();
	});
});

describe("renderTaskDetailView — comments (9.14.14)", () => {
	it("omits the Comments section without a comments config", () => {
		expect(mount(task()).view.root.querySelector(".tasks-detail__comments")).toBeNull();
	});

	it("renders the thread + an add box", () => {
		const { view } = mount(task(), {
			comments: {
				values: [
					{ id: "c1", body: "first", at: 0 },
					{ id: "c2", body: "second", at: 1 },
				],
				onAdd: vi.fn(),
				onRemove: vi.fn(),
			},
		});
		const bodies = [...view.root.querySelectorAll(".tasks-detail__comment-body")].map(
			(b) => b.textContent,
		);
		expect(bodies).toEqual(["first", "second"]);
		expect(view.root.querySelector(".tasks-detail__comment-input")).not.toBeNull();
	});

	it("posting fires onAdd with the trimmed body + clears; remove fires onRemove", () => {
		const onAdd = vi.fn();
		const onRemove = vi.fn();
		const { view } = mount(task(), {
			comments: { values: [{ id: "c1", body: "x", at: 0 }], onAdd, onRemove },
		});
		(view.root.querySelector(".tasks-detail__comment-remove") as HTMLButtonElement).click();
		expect(onRemove).toHaveBeenCalledWith("c1");
		const ta = view.root.querySelector(".tasks-detail__comment-input") as HTMLTextAreaElement;
		ta.value = "  hello there  ";
		(ta.closest("form") as HTMLFormElement).requestSubmit();
		expect(onAdd).toHaveBeenCalledWith("hello there");
		expect(ta.value).toBe("");
	});
});

describe("renderLegacyNotesFallback", () => {
	it("renders the legacy notes as preformatted read-only text", () => {
		const el = renderLegacyNotesFallback("line one\nline two");
		expect(el.textContent).toBe("line one\nline two");
		expect(el.className).toContain("tasks-detail__legacy-notes");
	});
});
