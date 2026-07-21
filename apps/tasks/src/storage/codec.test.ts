import { IconKind, RecurrenceKind, Weekday } from "@brainstorm-os/sdk-types";
import { describe, expect, it } from "vitest";
import type { Project } from "../types/project";
import { Priority, type Task } from "../types/task";
import {
	PROJECT_KEY_PREFIX,
	TASK_KEY_PREFIX,
	parseStoredProject,
	parseStoredTask,
	projectKey,
	serializeProject,
	serializeTask,
	taskKey,
} from "./codec";

function fullTask(): Task {
	return {
		id: "task_001",
		name: "Water the plants",
		notes: "Front porch + kitchen",
		completedAt: null,
		priority: Priority.High,
		scheduledAt: 1_700_000_000_000,
		dueAt: 1_700_086_400_000,
		projectId: "proj_garden",
		assigneeId: "person_mira",
		parentId: null,
		recurrence: { kind: RecurrenceKind.Weekly, every: 1, days: [Weekday.Mon, Weekday.Thu] },
		statusKey: "todo",
		createdAt: 1_699_000_000_000,
		updatedAt: 1_700_000_000_000,
	};
}

function fullProject(): Project {
	return {
		id: "proj_garden",
		name: "Garden refresh",
		description: "Spring 2026 overhaul",
		statusKey: "active",
		milestoneAt: 1_710_000_000_000,
		colorHint: "#4faa92",
		createdAt: 1_700_000_000_000,
		updatedAt: 1_700_086_400_000,
	};
}

describe("key builders", () => {
	it("prefix tasks and projects distinctly so a `task:*` scan never picks up projects", () => {
		expect(taskKey("abc")).toBe("task:abc");
		expect(projectKey("abc")).toBe("project:abc");
		expect(TASK_KEY_PREFIX).toBe("task:");
		expect(PROJECT_KEY_PREFIX).toBe("project:");
	});
});

describe("serialize / parse round-trip — Task", () => {
	it("survives a full-shape round-trip with no field drop", () => {
		const original = fullTask();
		const parsed = parseStoredTask(serializeTask(original));
		expect(parsed).toEqual(original);
	});

	it("clones the input so caller mutation after serialize doesn't leak into storage", () => {
		const original = fullTask();
		const wire = serializeTask(original);
		original.name = "mutated after serialize";
		expect(wire.name).toBe("Water the plants");
	});

	it("drops the optional `notes` field when absent — exactOptionalPropertyTypes guard", () => {
		const { notes: _notes, ...rest } = fullTask();
		const parsed = parseStoredTask(serializeTask(rest as Task));
		expect(parsed).not.toBeNull();
		expect(parsed && Object.hasOwn(parsed, "notes")).toBe(false);
	});
});

describe("parseStoredTask — boundary defence", () => {
	it("returns null for non-object input", () => {
		expect(parseStoredTask(null)).toBeNull();
		expect(parseStoredTask(undefined)).toBeNull();
		expect(parseStoredTask("not an object")).toBeNull();
		expect(parseStoredTask(42)).toBeNull();
	});

	it("returns null when required fields are missing or wrong-typed", () => {
		const base = fullTask() as unknown as Record<string, unknown>;
		const missingId = { ...base, id: "" };
		const missingName = { ...base, name: 42 };
		const missingCreatedAt = { ...base, createdAt: "not a number" };
		const missingUpdatedAt = { ...base, updatedAt: Number.NaN };
		expect(parseStoredTask(missingId)).toBeNull();
		expect(parseStoredTask(missingName)).toBeNull();
		expect(parseStoredTask(missingCreatedAt)).toBeNull();
		expect(parseStoredTask(missingUpdatedAt)).toBeNull();
	});

	it("coerces unknown priority to None — old rows from before the enum stabilised stay parsable", () => {
		const raw = { ...(fullTask() as unknown as Record<string, unknown>), priority: "ULTRA" };
		const parsed = parseStoredTask(raw);
		expect(parsed?.priority).toBe(Priority.None);
	});

	it("drops a malformed recurrence to null — the renderer treats it as not-recurring", () => {
		const raw = {
			...(fullTask() as unknown as Record<string, unknown>),
			recurrence: { kind: "BIWEEKLY", every: 2 },
		};
		const parsed = parseStoredTask(raw);
		expect(parsed?.recurrence).toBeNull();
	});

	it("defaults a missing / malformed assigneeId to null (pre-F-152 rows stay parsable)", () => {
		const { assigneeId: _drop, ...legacy } = fullTask() as unknown as Record<string, unknown>;
		expect(parseStoredTask(legacy)?.assigneeId).toBeNull();
		const malformed = { ...(fullTask() as unknown as Record<string, unknown>), assigneeId: 42 };
		expect(parseStoredTask(malformed)?.assigneeId).toBeNull();
	});

	it("normalises NaN / Infinity dates to null rather than carrying a poison value", () => {
		const raw = {
			...(fullTask() as unknown as Record<string, unknown>),
			scheduledAt: Number.NaN,
			dueAt: Number.POSITIVE_INFINITY,
		};
		const parsed = parseStoredTask(raw);
		expect(parsed?.scheduledAt).toBeNull();
		expect(parsed?.dueAt).toBeNull();
	});

	it("preserves a user-picked icon through serialize→parse — without this the icon disappears on every vaultEntities.onChange refresh while other apps still see it", () => {
		const emoji = { kind: IconKind.Emoji, value: "🌱" };
		const withIcon: Task = { ...fullTask(), icon: emoji };
		const parsed = parseStoredTask(serializeTask(withIcon));
		expect(parsed?.icon).toEqual(emoji);
	});

	it("drops a malformed icon shape rather than passing it through", () => {
		const raw = { ...(fullTask() as unknown as Record<string, unknown>), icon: { kind: "BOGUS" } };
		const parsed = parseStoredTask(raw);
		expect(parsed && Object.hasOwn(parsed, "icon")).toBe(false);
	});
});

describe("serialize / parse round-trip — Project", () => {
	it("survives a full-shape round-trip with no field drop", () => {
		const original = fullProject();
		const parsed = parseStoredProject(serializeProject(original));
		expect(parsed).toEqual(original);
	});

	it("drops malformed projects to null", () => {
		expect(parseStoredProject(null)).toBeNull();
		expect(parseStoredProject({ name: "no id" })).toBeNull();
		expect(parseStoredProject({ id: "", name: "empty id" })).toBeNull();
	});

	it("normalises out-of-band timestamp fields to null", () => {
		const raw = {
			...(fullProject() as unknown as Record<string, unknown>),
			milestoneAt: "not a number",
		};
		const parsed = parseStoredProject(raw);
		expect(parsed?.milestoneAt).toBeNull();
	});

	it("preserves a project's user-picked icon — same regression as Task icon, applied to project headers / sidebar entries", () => {
		const icon = { kind: IconKind.Emoji, value: "🪴" };
		const withIcon: Project = { ...fullProject(), icon };
		const parsed = parseStoredProject(serializeProject(withIcon));
		expect(parsed?.icon).toEqual(icon);
	});
});

describe("sortIndex — manual drag-and-drop position survives storage", () => {
	it("round-trips a numeric sortIndex on a project", () => {
		const original: Project = { ...fullProject(), sortIndex: 7 };
		const parsed = parseStoredProject(serializeProject(original));
		expect(parsed?.sortIndex).toBe(7);
	});

	it("round-trips a numeric sortIndex on a task", () => {
		const original: Task = { ...fullTask(), sortIndex: 3 };
		const parsed = parseStoredTask(serializeTask(original));
		expect(parsed?.sortIndex).toBe(3);
	});

	it("drops a missing sortIndex rather than materialising it as null — exactOptionalPropertyTypes contract", () => {
		const parsedProject = parseStoredProject(serializeProject(fullProject()));
		const parsedTask = parseStoredTask(serializeTask(fullTask()));
		expect(parsedProject && Object.hasOwn(parsedProject, "sortIndex")).toBe(false);
		expect(parsedTask && Object.hasOwn(parsedTask, "sortIndex")).toBe(false);
	});

	it("treats a non-numeric sortIndex as absent (defensive)", () => {
		const rawProject = {
			...(fullProject() as unknown as Record<string, unknown>),
			sortIndex: "not a number",
		};
		const rawTask = {
			...(fullTask() as unknown as Record<string, unknown>),
			sortIndex: Number.NaN,
		};
		const parsedProject = parseStoredProject(rawProject);
		const parsedTask = parseStoredTask(rawTask);
		expect(parsedProject && Object.hasOwn(parsedProject, "sortIndex")).toBe(false);
		expect(parsedTask && Object.hasOwn(parsedTask, "sortIndex")).toBe(false);
	});
});

describe("custom vault-property values (9.14.16)", () => {
	it("round-trips a non-empty values bag", () => {
		const original = { ...fullTask(), values: { "vault.effort": 5, "vault.notes": "deep" } };
		const parsed = parseStoredTask(serializeTask(original));
		expect(parsed?.values).toEqual({ "vault.effort": 5, "vault.notes": "deep" });
	});

	it("drops malformed or empty values bags instead of crashing", () => {
		const base = serializeTask(fullTask()) as Record<string, unknown>;
		expect(parseStoredTask({ ...base, values: [] })?.values).toBeUndefined();
		expect(parseStoredTask({ ...base, values: "nope" })?.values).toBeUndefined();
		expect(parseStoredTask({ ...base, values: {} })?.values).toBeUndefined();
	});
});
