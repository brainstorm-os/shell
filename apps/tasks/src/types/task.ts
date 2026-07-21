/**
 * `brainstorm/Task/v1` — focused-app entity for the Tasks surface.
 *
 * `statusKey` references a vault-level vocabulary dictionary (the
 * shell-side PropertiesService manages the dictionary; the Tasks app
 * seeds `task-status` with To-do / In progress / Done / Cancelled on
 * first run, but a user can rename / recolour / add states in
 * Settings → Data). A nullable `completedAt` is the canonical
 * "is this done?" signal even though `statusKey` may also reflect a
 * Done-equivalent — it carries the timestamp recurrence math needs.
 */

import type { Icon, Recurrence } from "@brainstorm-os/sdk-types";
import type { ValuesMap } from "@brainstorm-os/sdk/property-ui/pure";

/** Five priority levels — values are stored as the string discriminator,
 *  per the project-wide "no raw string literals as discriminators" rule
 *  in CLAUDE.md. */
export enum Priority {
	None = "none",
	Low = "low",
	Medium = "medium",
	High = "high",
	Critical = "critical",
}

/** All priorities in display order — frozen, safe to iterate. */
export const PRIORITIES: readonly Priority[] = Object.freeze([
	Priority.None,
	Priority.Low,
	Priority.Medium,
	Priority.High,
	Priority.Critical,
]);

/** Canonical keys of the seeded `task-status` vocabulary. An as-const map
 *  (not an enum) because `Task.statusKey` is an OPEN domain — users add
 *  custom states in Settings → Data — so the field stays `string | null`;
 *  these names just centralise the seeded literals per the project-wide
 *  "no raw string discriminators" rule. */
export const TaskStatus = {
	Todo: "todo",
	InProgress: "in-progress",
	Active: "active",
	Done: "done",
	Cancelled: "cancelled",
} as const;

export type TaskStatusKey = (typeof TaskStatus)[keyof typeof TaskStatus];

/** One entry in a task's comment / activity thread (9.14.14). */
export type TaskComment = {
	id: string;
	/** Plain-text comment body. */
	body: string;
	/** Epoch ms the comment was added. */
	at: number;
};

export type Task = {
	id: string;
	name: string;
	notes?: string;
	icon?: Icon | null;
	/** Read-only lock — the task's synced `locked` property. When true the
	 *  detail body editor is read-only. */
	locked?: boolean;

	/** Epoch ms of completion, or null if open. Truthy = done. */
	completedAt: number | null;

	priority: Priority;

	/** Epoch ms — when the user plans to do the task (calendar date). */
	scheduledAt: number | null;

	/** Epoch ms — hard deadline. Independent of `scheduledAt`. */
	dueAt: number | null;

	projectId: string | null;

	/** Entity id of the `brainstorm/Person/v1` who owns this task (F-152),
	 *  or null when unassigned. Registered in the vault property catalog as
	 *  an entityRef PropertyDef so the Task→Person edge projects into the
	 *  Graph automatically. */
	assigneeId: string | null;

	/** Parent task id for a subtask, or null for a top-level task (9.14.7).
	 *  A task is never its own ancestor — the setter guards the cycle. */
	parentId: string | null;

	/** Ids of tasks that must complete before this one can start (9.14.8) —
	 *  this task is "blocked by" them. Absent / empty = no dependencies. The
	 *  setter guards against dependency cycles. */
	dependsOn?: string[];

	/** Planned effort in whole minutes (9.14.13), or absent if unestimated. */
	estimateMinutes?: number;
	/** Effort logged so far in whole minutes (9.14.13), or absent. */
	loggedMinutes?: number;

	/** Free-form tags (9.14.10) for taxonomy + filtering. Absent / empty = none;
	 *  normalised to trimmed, de-duplicated, lower-cased labels. */
	tags?: string[];

	/** Comment / activity thread (9.14.14), oldest-first. Absent / empty = none. */
	comments?: TaskComment[];

	/** Custom vault-property values (9.14.16) — keys into the vault property
	 *  catalog, edited through the detail panel's shared cells (the same
	 *  `values` bag Notes / Journal entities carry). Absent / empty = none. */
	values?: ValuesMap;

	recurrence: Recurrence | null;

	/** Vocabulary key into the `task-status` dictionary (e.g. `todo`,
	 *  `in-progress`, `done`, `cancelled`). Nullable because the seeded
	 *  default isn't materialised on every task in the entity row. */
	statusKey: string | null;

	/** Manual position in a flat-list surface (Inbox or a single
	 *  project's task list). Null = no user-chosen position; the
	 *  compiler then falls back to the surface's automatic sort
	 *  (priority desc, then due/scheduled, then createdAt). Date-grouped
	 *  surfaces (Today, Upcoming) ignore this field — reordering across
	 *  date sections only makes sense via the date chip. */
	sortIndex?: number | null;

	createdAt: number;
	updatedAt: number;
};
