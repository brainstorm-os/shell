/**
 * Surface compiler — turns a flat task list into the rows + section
 * groupings each TaskSurface kind expects.
 *
 * **Long-term keystone** per [[preview-drop-pattern]]: the entities-
 * service swap at 9.14.2 changes the input source (`vaultEntities.list()`
 * snapshot vs. `DEMO_TASKS`) but the compiler stays — surface compilation
 * is the same shape over the same `Task[]` regardless of where the tasks
 * came from.
 *
 * Each surface has its own grouping shape:
 *   - **Inbox**     — single flat section, sorted: priority desc, then createdAt asc.
 *   - **Today**     — Overdue section + Today section, sorted within.
 *   - **Upcoming**  — date-grouped by `scheduledAt` (ascending dates) by
 *                     default; `upcomingGrouping` (F-164) re-sections the same
 *                     date-scoped set along any axis the "Group by" picker
 *                     offers — assignee, priority, project, status, or tags.
 *   - **Project**   — single flat section over the project's tasks.
 *
 * Done tasks always sort to the bottom; their inclusion is the caller's
 * choice (a `showCompleted` toggle on the renderer).
 */

import { TaskSurface, UpcomingGrouping } from "../types/surface";
import type { Task } from "../types/task";
import type { Priority } from "../types/task";
import {
	dateKey,
	endOfToday as endOfTodayMs,
	startOfToday as startOfTodayMs,
} from "./date-buckets";
import { topLevelTasks } from "./subtask-tree";
import { PRIORITY_RANK, TaskSort, sortTasks } from "./task-sort";
import { closedAt, isClosed, isOverdue, isPastDue } from "./task-status";

export type CompiledSection = {
	/** Stable section key — `inbox` / `today.overdue` / `today.today` /
	 *  `upcoming.2026-05-15` / `project.proj_brainstorm`. Used as the
	 *  caller's render-list key + the screen-reader heading id. */
	key: string;
	/** i18n key for the section heading. Ignored when `title` is set. */
	titleKey: string;
	/** Title params (e.g. `{ count: 3 }`). */
	titleParams?: Record<string, string | number>;
	/** Pre-resolved literal heading — used verbatim, skipping i18n. Set for
	 *  axis groupings (Priority / Project / Status / Tags) whose heading IS an
	 *  already-localized value (a priority name, a project title, a tag), so the
	 *  compiler doesn't route it through a useless `"{name}"` passthrough key. */
	title?: string;
	tasks: Task[];
};

export type CompiledSurface = {
	surface: TaskSurface;
	/** The project id when `surface === Project`, else null. */
	projectId: string | null;
	sections: CompiledSection[];
	/** Total task count across every section, *including* done if shown.
	 *  Used by the sidebar's count badges. */
	count: number;
};

export type CompileOptions = {
	/** Anchor for the Today / Upcoming bucketing. The caller passes its
	 *  own "now" (the demo uses DEMO_NOW; production passes `Date.now()`)
	 *  so the helper stays pure. */
	now: number;
	/** Whether completed tasks are included in the output. Default false. */
	showCompleted?: boolean;
	/** Required when `surface === Project`. */
	projectId?: string;
	/** How Upcoming sections its tasks (F-164). Default `Date`. */
	upcomingGrouping?: UpcomingGrouping;
	/** Within-section task order across every list surface. `Default` (or
	 *  omitted) keeps each surface's native order — including the manual
	 *  `sortIndex` on the flat lists; any other key re-orders the rows
	 *  inside each compiled section, done tasks still last. */
	sort?: TaskSort;
	/** Resolves an assignee entity id to its display name for the
	 *  assignee-grouped section headings. `null` = unknown (the index
	 *  hasn't hydrated, or the Person is gone) — the section then renders
	 *  the unknown-person heading. Only consulted when
	 *  `upcomingGrouping === Assignee`; injected so the compiler stays
	 *  pure over the entity-title source. */
	assigneeName?(assigneeId: string): string | null;
	/** Resolves a bucket key to its section heading for the Priority /
	 *  Project / Status grouping axes (Tags use the tag text itself).
	 *  Injected so the compiler stays pure over the i18n + project + status
	 *  label sources. Always returns a display string — the resolver folds
	 *  any "unknown id" fallback in itself. */
	groupLabel?(grouping: UpcomingGrouping, key: string): string;
};

export function compileSurface(
	allTasks: readonly Task[],
	surface: TaskSurface,
	opts: CompileOptions,
): CompiledSurface {
	const { now, showCompleted = false, projectId = null } = opts;
	const eot = endOfTodayMs(now);
	// Subtasks (9.14.7) live under their parent in the detail route, not as
	// standalone rows in the flat surfaces — so a child with an existing parent
	// is excluded here (an orphan whose parent is gone still surfaces).
	const topLevel = topLevelTasks(allTasks);
	const filtered = topLevel.filter((t) => (showCompleted ? true : !isClosed(t)));

	let compiled: CompiledSurface;
	switch (surface) {
		case TaskSurface.Inbox:
			compiled = inboxSurface(filtered);
			break;
		case TaskSurface.Today:
			compiled = todaySurface(filtered, now, eot);
			break;
		case TaskSurface.Upcoming:
			switch (opts.upcomingGrouping) {
				case UpcomingGrouping.Assignee:
					compiled = upcomingSurfaceByAssignee(filtered, eot, opts.assigneeName ?? (() => null));
					break;
				case UpcomingGrouping.Priority:
				case UpcomingGrouping.Project:
				case UpcomingGrouping.Status:
				case UpcomingGrouping.Tags:
					compiled = upcomingSurfaceByAxis(
						filtered,
						eot,
						opts.upcomingGrouping,
						opts.groupLabel ?? ((_g, key) => key),
					);
					break;
				default:
					compiled = upcomingSurface(filtered, eot);
			}
			break;
		case TaskSurface.Project: {
			if (projectId === null) {
				throw new Error("compileSurface: surface=Project requires opts.projectId");
			}
			compiled = projectSurface(filtered, projectId);
			break;
		}
		case TaskSurface.Board:
			// The Board surface is rendered from `compileBoard`, not the flat
			// surface compiler — it should never reach here.
			throw new Error("compileSurface: Board uses compileBoard, not compileSurface");
		case TaskSurface.Timeline:
			// Same shape as Board: the timeline renders from `compileGantt`.
			throw new Error("compileSurface: Timeline uses compileGantt, not compileSurface");
	}

	return applySort(compiled, opts.sort);
}

/** Re-order the tasks inside every compiled section by an explicit sort key.
 *  `Default` (or omitted) is a no-op — the surface keeps its native order,
 *  including manual `sortIndex` on the flat lists. Section count + headings
 *  are untouched; only intra-section row order changes. */
function applySort(compiled: CompiledSurface, sort: TaskSort | undefined): CompiledSurface {
	if (sort === undefined || sort === TaskSort.Default) return compiled;
	return {
		...compiled,
		sections: compiled.sections.map((section) => ({
			...section,
			tasks: sortTasks(section.tasks, sort),
		})),
	};
}

function inboxSurface(tasks: readonly Task[]): CompiledSurface {
	const inbox = tasks.filter((t) => t.projectId === null && t.scheduledAt === null);
	const sorted = sortFlatList(inbox, sortByPriorityThenCreated);
	return {
		surface: TaskSurface.Inbox,
		projectId: null,
		sections: [
			{
				key: "inbox",
				titleKey: "tasks.section.inbox",
				tasks: sorted,
			},
		],
		count: sorted.length,
	};
}

function todaySurface(tasks: readonly Task[], now: number, endOfToday: number): CompiledSurface {
	// Today is a date-driven view, not a no-project view: a project-bound
	// task scheduled today (or overdue) appears here AND under its
	// project. The earlier `surfaceFor === Today` predicate excluded
	// project-bound tasks via the Project-takes-precedence routing, which
	// emptied Today out for any plan-seeded vault (every iteration belongs
	// to its stage's project — e.g. `proj-9`). Keeping `isOverdue` in
	// the OR matches the original semantics (overdue project tasks
	// already surfaced here pre-change).
	// `tasks` has already been filtered for done-ness by the caller per
	// `showCompleted`; when completed tasks are present they qualify for
	// Today only by their completion date (below), never by a past schedule.
	const startOfToday = startOfTodayMs(now);
	const candidates = tasks.filter((t) => {
		// A *completed* task belongs to Today only if it was finished today.
		// The open-task rule below (`scheduledAt <= endOfToday`) matches every
		// row scheduled on or before today — fine for open work that rolls
		// forward, but applied to done tasks it pulled in the entire backlog of
		// long-finished work the moment `showCompleted` was on (hundreds of
		// rows whose only crime was a past scheduled date).
		if (isClosed(t)) {
			const at = closedAt(t);
			return at >= startOfToday && at <= endOfToday;
		}
		return (t.scheduledAt !== null && t.scheduledAt <= endOfToday) || isOverdue(t, now);
	});

	// Past-scheduled open work still belongs on the Today *surface* (it rolls
	// forward and stays actionable), but it surfaces under Overdue — not the
	// literal "Today" heading — so the section labels stay honest and
	// genuinely-today work isn't buried under a week of stale "2 Jun" rows.
	// `isPastDue` is the shared definition the row chip uses too.
	const overdue = candidates.filter((t) => isPastDue(t, now));
	const overdueSet = new Set(overdue.map((t) => t.id));
	const today = candidates.filter((t) => !overdueSet.has(t.id));

	const sections: CompiledSection[] = [];
	if (overdue.length > 0) {
		sections.push({
			key: "today.overdue",
			titleKey: "tasks.section.overdue",
			titleParams: { count: overdue.length },
			tasks: sortByDueOrScheduled(overdue),
		});
	}
	// Only emit the Today section when it has rows: a bare "Today · 0" header
	// sitting under a populated Overdue section reads as a broken/unfinished
	// group. The genuinely-empty surface (both sections empty) is caught by the
	// renderer's `count === 0` empty-state, not by a lone empty header.
	if (today.length > 0) {
		sections.push({
			key: "today.today",
			titleKey: "tasks.section.today",
			titleParams: { count: today.length },
			tasks: sortByDueOrScheduled(today),
		});
	}

	return {
		surface: TaskSurface.Today,
		projectId: null,
		sections,
		count: overdue.length + today.length,
	};
}

/** Mirror todaySurface: Upcoming is date-driven, not no-project. A
 *  project-bound task scheduled past today appears here AND under its
 *  project. `tasks` is already filtered for done-ness by the caller
 *  per `showCompleted`. Shared by both Upcoming groupings so toggling
 *  the grouping never changes WHICH tasks are in view, only how they
 *  section. */
function upcomingTasks(tasks: readonly Task[], endOfToday: number): Task[] {
	return tasks.filter((t) => t.scheduledAt !== null && t.scheduledAt > endOfToday);
}

function upcomingSurface(tasks: readonly Task[], endOfToday: number): CompiledSurface {
	const upcoming = upcomingTasks(tasks, endOfToday);

	const byKey = new Map<string, Task[]>();
	const dayStartByKey = new Map<string, number>();
	for (const task of upcoming) {
		if (task.scheduledAt === null) continue;
		const key = dateKey(task.scheduledAt);
		const list = byKey.get(key) ?? [];
		list.push(task);
		byKey.set(key, list);
		if (!dayStartByKey.has(key)) {
			const d = new Date(task.scheduledAt);
			d.setHours(0, 0, 0, 0);
			dayStartByKey.set(key, d.getTime());
		}
	}

	const sections: CompiledSection[] = [...byKey.entries()]
		.map(([key, tasks]) => ({
			key: `upcoming.${key}`,
			titleKey: "tasks.section.date",
			titleParams: { date: key },
			tasks: sortByDueOrScheduled(tasks),
			_start: dayStartByKey.get(key) ?? 0,
		}))
		.sort((a, b) => a._start - b._start)
		.map(({ _start, ...rest }) => rest);

	return {
		surface: TaskSurface.Upcoming,
		projectId: null,
		sections,
		count: upcoming.length,
	};
}

/** Upcoming grouped per person (F-164) — "what's on Priya's plate this
 *  week". Same date-scoped task set as the date grouping; one section
 *  per assignee, named sections first (display-name ascending), then
 *  unresolvable assignees (stable by id), then Unassigned last. */
function upcomingSurfaceByAssignee(
	tasks: readonly Task[],
	endOfToday: number,
	assigneeName: (assigneeId: string) => string | null,
): CompiledSurface {
	const upcoming = upcomingTasks(tasks, endOfToday);

	const byAssignee = new Map<string | null, Task[]>();
	for (const task of upcoming) {
		const list = byAssignee.get(task.assigneeId) ?? [];
		list.push(task);
		byAssignee.set(task.assigneeId, list);
	}

	const assigned = [...byAssignee.entries()]
		.filter((entry): entry is [string, Task[]] => entry[0] !== null)
		.map(([id, tasks]) => ({ id, name: assigneeName(id), tasks }))
		.sort((a, b) => {
			if (a.name !== null && b.name !== null) return a.name.localeCompare(b.name);
			if (a.name === null && b.name === null) return a.id.localeCompare(b.id);
			return a.name === null ? 1 : -1;
		});

	const sections: CompiledSection[] = assigned.map(({ id, name, tasks }) => ({
		key: `upcoming.assignee.${id}`,
		...(name !== null
			? { titleKey: "tasks.section.assignee", titleParams: { name } }
			: { titleKey: "tasks.assignee.unknown" }),
		tasks: sortByDueOrScheduled(tasks),
	}));

	const unassigned = byAssignee.get(null);
	if (unassigned && unassigned.length > 0) {
		sections.push({
			key: "upcoming.unassigned",
			titleKey: "tasks.section.unassigned",
			tasks: sortByDueOrScheduled(unassigned),
		});
	}

	return {
		surface: TaskSurface.Upcoming,
		projectId: null,
		sections,
		count: upcoming.length,
	};
}

/** The bucket key(s) a task lands in for a given grouping axis. Tags are
 *  multi-valued — a task appears under each of its tags; the other axes are
 *  single-keyed. An empty array means the task has no value on this axis and
 *  falls into the trailing "none" bucket (untagged / no project / no status).
 *  Priority always yields a key (every task has a priority, `None` included). */
function axisKeys(task: Task, grouping: UpcomingGrouping): string[] {
	switch (grouping) {
		case UpcomingGrouping.Priority:
			return [task.priority];
		case UpcomingGrouping.Project:
			return task.projectId !== null ? [task.projectId] : [];
		case UpcomingGrouping.Status:
			return task.statusKey !== null ? [task.statusKey] : [];
		case UpcomingGrouping.Tags:
			return task.tags && task.tags.length > 0 ? [...task.tags] : [];
		default:
			return [];
	}
}

/** i18n key for the trailing "none" section of an axis that has one. */
const NONE_TITLE_KEY: Partial<Record<UpcomingGrouping, string>> = {
	[UpcomingGrouping.Project]: "tasks.section.noProject",
	[UpcomingGrouping.Status]: "tasks.section.noStatus",
	[UpcomingGrouping.Tags]: "tasks.section.noTags",
};

/** Upcoming re-sectioned along an arbitrary task axis (Priority / Project /
 *  Status / Tags) — the flexible counterpart to the date + assignee groupings.
 *  Same date-scoped task set; one section per distinct axis value, ordered by
 *  rank (Priority, Critical first) or display label (the rest), with the
 *  value-less "none" bucket always last. Section headings come from the
 *  injected `label` resolver so the compiler stays pure. */
function upcomingSurfaceByAxis(
	tasks: readonly Task[],
	endOfToday: number,
	grouping: UpcomingGrouping,
	label: (grouping: UpcomingGrouping, key: string) => string,
): CompiledSurface {
	const upcoming = upcomingTasks(tasks, endOfToday);

	const byKey = new Map<string, Task[]>();
	const noneTasks: Task[] = [];
	for (const task of upcoming) {
		const keys = axisKeys(task, grouping);
		if (keys.length === 0) {
			noneTasks.push(task);
			continue;
		}
		for (const key of keys) {
			const list = byKey.get(key) ?? [];
			list.push(task);
			byKey.set(key, list);
		}
	}

	const buckets = [...byKey.entries()].map(([key, tasks]) => ({
		key,
		// Tags are their own label; everything else resolves through the injected
		// label source (priority i18n, project name, status vocabulary).
		label: grouping === UpcomingGrouping.Tags ? key : label(grouping, key),
		tasks,
	}));
	buckets.sort((a, b) => {
		if (grouping === UpcomingGrouping.Priority) {
			const dp = (PRIORITY_RANK[b.key as Priority] ?? 0) - (PRIORITY_RANK[a.key as Priority] ?? 0);
			if (dp !== 0) return dp;
		}
		return a.label.localeCompare(b.label);
	});

	const sections: CompiledSection[] = buckets.map(({ key, label: name, tasks }) => ({
		key: `upcoming.${grouping}.${key}`,
		titleKey: "",
		title: name,
		tasks: sortByDueOrScheduled(tasks),
	}));

	if (noneTasks.length > 0) {
		sections.push({
			key: `upcoming.${grouping}.none`,
			titleKey: NONE_TITLE_KEY[grouping] ?? "",
			tasks: sortByDueOrScheduled(noneTasks),
		});
	}

	return {
		surface: TaskSurface.Upcoming,
		projectId: null,
		sections,
		count: upcoming.length,
	};
}

function projectSurface(tasks: readonly Task[], projectId: string): CompiledSurface {
	const inProject = tasks.filter((t) => t.projectId === projectId);
	const sorted = sortFlatList(inProject, sortByDueOrScheduled);
	return {
		surface: TaskSurface.Project,
		projectId,
		sections: [
			{
				key: `project.${projectId}`,
				titleKey: "tasks.section.project",
				tasks: sorted,
			},
		],
		count: sorted.length,
	};
}

/** Flat-list surfaces (Inbox / Project) honour `sortIndex` when any task
 *  in the list has one set: tasks with an index sort first (ascending),
 *  every unindexed open task falls through to the automatic order, and
 *  done tasks always sink to the bottom by `completedAt` desc — even if
 *  they used to have a `sortIndex` from when they were open. Mixing
 *  manual + auto in the same list lets a partly-reordered list stay
 *  readable instead of dumping unindexed rows at the very top or bottom. */
function sortFlatList(
	tasks: readonly Task[],
	autoSort: (input: readonly Task[]) => Task[],
): Task[] {
	const hasManual = tasks.some((t) => !isClosed(t) && typeof t.sortIndex === "number");
	if (!hasManual) return autoSort(tasks);

	const open = tasks.filter((t) => !isClosed(t));
	const done = tasks.filter((t) => isClosed(t));
	const manual = open.filter((t) => typeof t.sortIndex === "number");
	const auto = open.filter((t) => typeof t.sortIndex !== "number");

	manual.sort((a, b) => {
		const ai = a.sortIndex ?? 0;
		const bi = b.sortIndex ?? 0;
		if (ai !== bi) return ai - bi;
		return a.createdAt - b.createdAt;
	});
	const autoSorted = autoSort(auto);
	done.sort((a, b) => closedAt(b) - closedAt(a));
	return [...manual, ...autoSorted, ...done];
}

/** Sort: open tasks first (by priority desc, then createdAt asc), then
 *  done tasks (by completedAt desc — most recently completed first). */
function sortByPriorityThenCreated(tasks: readonly Task[]): Task[] {
	return [...tasks].sort((a, b) => {
		const aDone = isClosed(a);
		const bDone = isClosed(b);
		if (aDone !== bDone) return aDone ? 1 : -1;
		if (aDone && bDone) return closedAt(b) - closedAt(a);
		const dp = (PRIORITY_RANK[b.priority] ?? 0) - (PRIORITY_RANK[a.priority] ?? 0);
		if (dp !== 0) return dp;
		return a.createdAt - b.createdAt;
	});
}

/** Sort: open tasks first (by `dueAt ?? scheduledAt`, ascending — null
 *  goes to the end), tie-break by priority desc, then createdAt; done
 *  tasks go to the bottom in completedAt-desc order. */
function sortByDueOrScheduled(tasks: readonly Task[]): Task[] {
	return [...tasks].sort((a, b) => {
		const aDone = isClosed(a);
		const bDone = isClosed(b);
		if (aDone !== bDone) return aDone ? 1 : -1;
		if (aDone && bDone) return closedAt(b) - closedAt(a);
		const ak = a.dueAt ?? a.scheduledAt ?? null;
		const bk = b.dueAt ?? b.scheduledAt ?? null;
		if (ak !== null && bk !== null && ak !== bk) return ak - bk;
		if (ak === null && bk !== null) return 1; // null goes after a real timestamp
		if (bk === null && ak !== null) return -1;
		const dp = (PRIORITY_RANK[b.priority] ?? 0) - (PRIORITY_RANK[a.priority] ?? 0);
		if (dp !== 0) return dp;
		return a.createdAt - b.createdAt;
	});
}
