/**
 * @vitest-environment jsdom
 *
 * Perf-regression guard for the Tasks plain-DOM hot path.
 *
 * The whole point of `targeted-row-update` is that a single-task
 * mutation patches ONE `<li>` instead of tearing down + rebuilding the
 * entire list (the old `contentSlot.replaceChildren(renderSurfaceView)`
 * that ran on every toggle). These tests assert exactly that: every
 * untouched row keeps its *same DOM node* across a single-row swap, and
 * the structural-vs-targeted decision (`sequenceChanged`) is correct.
 */

import { afterEach, describe, expect, it } from "vitest";
import { Priority, type Task } from "../types/task";
import {
	removeTaskRowInPlace,
	replaceTaskRowInPlace,
	sequenceChanged,
	visibleTaskIdSequence,
} from "./targeted-row-update";
import { type TaskRowProps, renderTaskRow } from "./task-row";

function task(id: string, overrides: Partial<Task> = {}): Task {
	return {
		id,
		name: `Task ${id}`,
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

function rowProps(t: Task): TaskRowProps {
	return {
		task: t,
		now: 0,
		projectsById: new Map(),
		showProjectChip: false,
		onToggleComplete: () => {},
		onPickIcon: () => {},
		onRenameTask: () => {},
		onOpenEdit: () => {},
		onSelectTask: () => {},
		objectMenuEnabled: true,
	};
}

function mountList(tasks: readonly Task[]): HTMLUListElement {
	const ul = document.createElement("ul");
	for (const t of tasks) ul.appendChild(renderTaskRow(rowProps(t)));
	document.body.appendChild(ul);
	return ul;
}

afterEach(() => {
	document.body.replaceChildren();
});

describe("visibleTaskIdSequence", () => {
	it("reads the rendered task ids in document order", () => {
		const ul = mountList([task("a"), task("b"), task("c")]);
		expect(visibleTaskIdSequence(ul)).toEqual(["a", "b", "c"]);
	});
});

describe("sequenceChanged", () => {
	it("is false for identical sequences (→ targeted patch)", () => {
		expect(sequenceChanged(["a", "b"], ["a", "b"])).toBe(false);
	});
	it("is true on membership change (→ full render)", () => {
		expect(sequenceChanged(["a", "b"], ["a"])).toBe(true);
	});
	it("is true on reorder (→ full render)", () => {
		expect(sequenceChanged(["a", "b"], ["b", "a"])).toBe(true);
	});
});

describe("replaceTaskRowInPlace", () => {
	it("swaps ONLY the target row — every other <li> is the same node", () => {
		const ul = mountList([task("a"), task("b"), task("c")]);
		const [liA, liB, liC] = Array.from(ul.children) as HTMLElement[];

		const ok = replaceTaskRowInPlace(ul, "b", rowProps(task("b", { completedAt: 123 })));

		expect(ok).toBe(true);
		const after = Array.from(ul.children) as HTMLElement[];
		// Untouched rows: SAME node reference (not re-instantiated).
		expect(after[0]).toBe(liA);
		expect(after[2]).toBe(liC);
		// Target row: a fresh node reflecting the mutation.
		expect(after[1]).not.toBe(liB);
		expect(after[1]?.dataset.taskId).toBe("b");
		expect(after[1]?.dataset.done).toBe("true");
		// Order + count preserved.
		expect(visibleTaskIdSequence(ul)).toEqual(["a", "b", "c"]);
	});

	it("preserves focus on the structurally-equivalent control", () => {
		const ul = mountList([task("a"), task("b")]);
		const toggleB = ul.children[1]?.querySelector<HTMLButtonElement>(".task-row__toggle");
		toggleB?.focus();
		expect(document.activeElement).toBe(toggleB);

		replaceTaskRowInPlace(ul, "b", rowProps(task("b", { completedAt: 1 })));

		const freshToggle = ul.children[1]?.querySelector<HTMLButtonElement>(".task-row__toggle");
		expect(document.activeElement).toBe(freshToggle);
		expect(freshToggle).not.toBe(toggleB);
	});

	it("returns false (no-op) when the row isn't on screen", () => {
		const ul = mountList([task("a")]);
		expect(replaceTaskRowInPlace(ul, "missing", rowProps(task("missing")))).toBe(false);
		expect(visibleTaskIdSequence(ul)).toEqual(["a"]);
	});
});

describe("removeTaskRowInPlace", () => {
	it("removes only the target row, leaving siblings as the same nodes", () => {
		const ul = mountList([task("a"), task("b"), task("c")]);
		const [liA, , liC] = Array.from(ul.children) as HTMLElement[];

		expect(removeTaskRowInPlace(ul, "b")).toBe(true);

		const after = Array.from(ul.children) as HTMLElement[];
		expect(after).toHaveLength(2);
		expect(after[0]).toBe(liA);
		expect(after[1]).toBe(liC);
	});
});
