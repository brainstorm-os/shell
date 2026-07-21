/**
 * Tests for the quick-look fact-sheet projection — the pure core behind
 * `intent.quick-look`. Field selection rules only emit rows with signal;
 * Status always anchors the sheet.
 */
import { DEFAULT_RECURRENCE_LABELS, RecurrenceKind } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import type { Project } from "../types/project";
import { Priority, type Task } from "../types/task";
import { buildQuickLookSheet } from "./quick-look";

const NOW = Date.UTC(2026, 4, 18, 12, 0, 0);

function task(over: Partial<Task>): Task {
	return {
		id: "t1",
		name: "Sample task",
		notes: "",
		icon: null,
		completedAt: null,
		priority: Priority.None,
		scheduledAt: null,
		dueAt: null,
		projectId: null,
		assigneeId: null,
		parentId: null,
		recurrence: null,
		statusKey: null,
		createdAt: NOW - 1000,
		updatedAt: NOW - 1000,
		...over,
	};
}

const project: Project = {
	id: "proj-a",
	name: "Roadmap",
	statusKey: null,
	milestoneAt: null,
	colorHint: null,
	createdAt: NOW,
	updatedAt: NOW,
};

const ctx = (t: Task) => ({
	task: t,
	projectsById: new Map([[project.id, project]]),
	formatDate: (ms: number) => `D${ms}`,
	t: (key: string) => key,
	recurrenceLabels: DEFAULT_RECURRENCE_LABELS,
});

describe("buildQuickLookSheet", () => {
	it("titles the sheet with the task name and always emits a Status row", () => {
		const sheet = buildQuickLookSheet(ctx(task({})));
		expect(sheet.title).toBe("Sample task");
		expect(sheet.rows[0]).toEqual({
			labelKey: "tasks.quickLook.field.status",
			value: "tasks.quickLook.value.open",
		});
	});

	it("reports a completed task as done", () => {
		const sheet = buildQuickLookSheet(ctx(task({ completedAt: NOW })));
		expect(sheet.rows[0]?.value).toBe("tasks.quickLook.value.done");
	});

	it("omits empty fields (no project / priority / dates / notes noise)", () => {
		const sheet = buildQuickLookSheet(ctx(task({})));
		expect(sheet.rows).toHaveLength(1);
	});

	it("includes a resolved project name", () => {
		const sheet = buildQuickLookSheet(ctx(task({ projectId: "proj-a" })));
		expect(sheet.rows).toContainEqual({
			labelKey: "tasks.quickLook.field.project",
			value: "Roadmap",
		});
	});

	it("drops a dangling project reference", () => {
		const sheet = buildQuickLookSheet(ctx(task({ projectId: "ghost" })));
		expect(sheet.rows.some((r) => r.labelKey === "tasks.quickLook.field.project")).toBe(false);
	});

	it("formats dates through the injected formatter", () => {
		const sheet = buildQuickLookSheet(ctx(task({ dueAt: 123, scheduledAt: 456 })));
		expect(sheet.rows).toContainEqual({ labelKey: "tasks.quickLook.field.due", value: "D123" });
		expect(sheet.rows).toContainEqual({
			labelKey: "tasks.quickLook.field.scheduled",
			value: "D456",
		});
	});

	it("summarises recurrence", () => {
		const sheet = buildQuickLookSheet(
			ctx(task({ recurrence: { kind: RecurrenceKind.Daily, every: 1 } })),
		);
		expect(sheet.rows).toContainEqual({
			labelKey: "tasks.quickLook.field.recurrence",
			value: "Every day",
		});
	});

	it("includes trimmed notes only when non-empty", () => {
		expect(buildQuickLookSheet(ctx(task({ notes: "  remember  " }))).rows).toContainEqual({
			labelKey: "tasks.quickLook.field.notes",
			value: "remember",
		});
		expect(
			buildQuickLookSheet(ctx(task({ notes: "   " }))).rows.some(
				(r) => r.labelKey === "tasks.quickLook.field.notes",
			),
		).toBe(false);
	});

	it("emits priority only when not None", () => {
		expect(buildQuickLookSheet(ctx(task({ priority: Priority.High }))).rows).toContainEqual({
			labelKey: "tasks.quickLook.field.priority",
			value: "tasks.priority.high",
		});
		expect(
			buildQuickLookSheet(ctx(task({ priority: Priority.None }))).rows.some(
				(r) => r.labelKey === "tasks.quickLook.field.priority",
			),
		).toBe(false);
	});
});
