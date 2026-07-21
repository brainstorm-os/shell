/**
 * Demo dataset for the 9.14.1.5 Tasks preview drop.
 *
 * Per [[preview-drop-pattern]] memory: the dataset is the renderer's
 * source until the entities service (Stage 9.3) lands. Long-term
 * keystones (`compileSurface`, `endOfToday`, `groupByDate`, the
 * recurrence engine, `surfaceFor`) survive the swap — the entities
 * service replaces `DEMO_TASKS` + `DEMO_PROJECTS` with live
 * `vaultEntities.list()` snapshots in 9.14.2.
 *
 * Hand-crafted across four realistic projects + ~30 tasks spanning
 * Inbox / Today / Upcoming / Project surfaces, with overdue tasks,
 * recurring tasks, varied priorities, and a few done items so each
 * surface paints a non-trivial render.
 */

import { RecurrenceKind, Weekday } from "@brainstorm-os/sdk-types";
import type { Project } from "../types/project";
import { Priority, type Task } from "../types/task";

const D = (iso: string): number => new Date(iso).getTime();

/** "Now" for the demo. All scheduled / due dates are relative to this
 *  so the screen reads sensibly without time-travel. The renderer reads
 *  this same anchor for `isOverdue` + `surfaceFor` so the demo is
 *  internally consistent. */
export const DEMO_NOW = D("2026-05-14T10:00:00");
const DAY = 86_400_000;

export const DEMO_PROJECTS: Project[] = [
	{
		id: "proj_brainstorm",
		name: "Brainstorm v1",
		description: "Ship the v1 line — Stage 9 + 10 + 12 + 13.",
		statusKey: "active",
		milestoneAt: DEMO_NOW + 90 * DAY,
		colorHint: "#d49241",
		createdAt: DEMO_NOW - 60 * DAY,
		updatedAt: DEMO_NOW - 1 * DAY,
	},
	{
		id: "proj_personal",
		name: "Personal",
		description: "Errands, bills, life logistics.",
		statusKey: "active",
		milestoneAt: null,
		colorHint: "#5491cf",
		createdAt: DEMO_NOW - 120 * DAY,
		updatedAt: DEMO_NOW - 3 * DAY,
	},
	{
		id: "proj_garden",
		name: "Garden refresh",
		description: "Spring 2026 garden overhaul.",
		statusKey: "active",
		milestoneAt: DEMO_NOW + 21 * DAY,
		colorHint: "#4faa92",
		createdAt: DEMO_NOW - 14 * DAY,
		updatedAt: DEMO_NOW - 2 * DAY,
	},
	{
		id: "proj_reading",
		name: "Reading list",
		description: "Books, articles, papers to get through.",
		statusKey: "active",
		milestoneAt: null,
		colorHint: "#8867d0",
		createdAt: DEMO_NOW - 200 * DAY,
		updatedAt: DEMO_NOW - 5 * DAY,
	},
];

let tid = 0;
function task(overrides: Partial<Task> & Pick<Task, "name">): Task {
	tid += 1;
	return {
		id: `task_${String(tid).padStart(3, "0")}`,
		completedAt: null,
		priority: Priority.None,
		scheduledAt: null,
		dueAt: null,
		projectId: null,
		assigneeId: null,
		parentId: null,
		recurrence: null,
		statusKey: null,
		createdAt: DEMO_NOW - 7 * DAY,
		updatedAt: DEMO_NOW - 1 * DAY,
		...overrides,
	};
}

export const DEMO_TASKS: Task[] = [
	// ── Inbox (no project, no schedule) ────────────────────────────────────
	task({ name: "Call back the landlord about the broken radiator", priority: Priority.High }),
	task({ name: "Pick a present for Anna's birthday" }),
	task({ name: "Decide on therapist for next month" }),
	task({ name: "Find that one book about resource scheduling" }),
	task({ name: "Cancel the free trial that's about to bill" }),

	// ── Today (scheduled ≤ today, no project so they show in Today) ───────
	task({
		name: "Reply to the bank about KYC documents",
		scheduledAt: DEMO_NOW + 2 * 3_600_000,
		dueAt: DEMO_NOW + 8 * 3_600_000,
		priority: Priority.Critical,
	}),
	task({
		name: "Buy groceries (milk, sourdough, tomatoes, oat yoghurt)",
		scheduledAt: DEMO_NOW - 2 * 3_600_000,
	}),
	task({
		name: "Water the plants",
		scheduledAt: DEMO_NOW - 4 * 3_600_000,
		recurrence: { kind: RecurrenceKind.Daily, every: 2 },
	}),
	task({
		name: "Reschedule dentist appointment",
		scheduledAt: DEMO_NOW - 10 * DAY,
		dueAt: DEMO_NOW - 1 * DAY,
		priority: Priority.High,
	}),

	// ── Upcoming (scheduled > today, no project) ───────────────────────────
	task({
		name: "Pay quarterly tax estimate",
		scheduledAt: DEMO_NOW + 5 * DAY,
		dueAt: DEMO_NOW + 5 * DAY,
		priority: Priority.Critical,
	}),
	task({ name: "Send postcard from the conference", scheduledAt: DEMO_NOW + 2 * DAY }),
	task({
		name: "Annual physical",
		scheduledAt: DEMO_NOW + 12 * DAY,
		priority: Priority.Medium,
	}),
	task({
		name: "Renew library card",
		scheduledAt: DEMO_NOW + 21 * DAY,
	}),
	task({
		name: "Weekly meal plan",
		scheduledAt: DEMO_NOW + 3 * DAY,
		recurrence: { kind: RecurrenceKind.Weekly, every: 1, days: [Weekday.Sun] },
	}),
	task({
		name: "Update LinkedIn",
		scheduledAt: DEMO_NOW + 14 * DAY,
		priority: Priority.Low,
	}),

	// ── Brainstorm v1 project ──────────────────────────────────────────────
	task({
		name: "Land 9.14.1 Tasks scaffold",
		projectId: "proj_brainstorm",
		completedAt: DEMO_NOW - 0.2 * DAY,
		priority: Priority.High,
	}),
	task({
		name: "Wire entities service (9.14.2) — replace DEMO_TASKS",
		projectId: "proj_brainstorm",
		scheduledAt: DEMO_NOW + 2 * DAY,
		priority: Priority.High,
	}),
	task({
		name: "Ship inline-task BP block (9.14.3)",
		projectId: "proj_brainstorm",
		scheduledAt: DEMO_NOW + 7 * DAY,
		priority: Priority.Medium,
	}),
	task({
		name: "Cross-app polish — Calendar / Graph / Database (9.14.4)",
		projectId: "proj_brainstorm",
		scheduledAt: DEMO_NOW + 14 * DAY,
		priority: Priority.Medium,
	}),
	task({
		name: "Calendar app scaffold (9.15.1)",
		projectId: "proj_brainstorm",
		scheduledAt: DEMO_NOW + 21 * DAY,
		priority: Priority.Medium,
	}),
	task({
		name: "Resolve OQ-WB-1 / OQ-WB-2 before Whiteboard",
		projectId: "proj_brainstorm",
		priority: Priority.Low,
	}),

	// ── Personal project ───────────────────────────────────────────────────
	task({
		name: "File expense reimbursements",
		projectId: "proj_personal",
		dueAt: DEMO_NOW + 30 * DAY,
		priority: Priority.Medium,
	}),
	task({
		name: "Schedule car service",
		projectId: "proj_personal",
		scheduledAt: DEMO_NOW + 10 * DAY,
	}),
	task({
		name: "Take winter clothes to dry cleaner",
		projectId: "proj_personal",
		completedAt: DEMO_NOW - 4 * DAY,
	}),
	task({
		name: "Renew gym membership",
		projectId: "proj_personal",
		scheduledAt: DEMO_NOW + 28 * DAY,
		priority: Priority.Low,
	}),

	// ── Garden refresh project ─────────────────────────────────────────────
	task({
		name: "Order tomato + basil starts",
		projectId: "proj_garden",
		scheduledAt: DEMO_NOW + 1 * DAY,
		priority: Priority.High,
	}),
	task({
		name: "Build raised bed in the back corner",
		projectId: "proj_garden",
		scheduledAt: DEMO_NOW + 4 * DAY,
		priority: Priority.Medium,
	}),
	task({
		name: "Lay drip irrigation",
		projectId: "proj_garden",
		scheduledAt: DEMO_NOW + 8 * DAY,
	}),
	task({
		name: "Sketch pollinator border on graph paper",
		projectId: "proj_garden",
		completedAt: DEMO_NOW - 7 * DAY,
	}),

	// ── Reading list project ───────────────────────────────────────────────
	task({
		name: "Finish 'The Body Keeps the Score'",
		projectId: "proj_reading",
		priority: Priority.Low,
	}),
	task({
		name: "Read latest Werner Vogels blog post",
		projectId: "proj_reading",
		completedAt: DEMO_NOW - 2 * DAY,
	}),
	task({
		name: "Skim the new Lex Fridman pod transcript",
		projectId: "proj_reading",
	}),
	task({
		name: "Read 'Why We Sleep' chapter 4",
		projectId: "proj_reading",
		recurrence: {
			kind: RecurrenceKind.Weekly,
			every: 1,
			days: [Weekday.Tue, Weekday.Thu],
		},
		scheduledAt: DEMO_NOW + 1 * DAY,
		priority: Priority.Low,
	}),
];
