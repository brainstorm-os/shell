/**
 * Tasks dashboard widget (Stage 7.3a). When Tasks is launched as a dashboard
 * widget (`launch.reason === "widget"`), `app.ts` mounts this instead of the
 * full app — the same bundle, in widget-mode. The one registered widget,
 * `open-tasks`, is a glance list of INCOMPLETE tasks with an in-widget sort
 * control; the shell strip above draws the title / open / collapse / ⋯ chrome,
 * and clicking a row opens that task in the full Tasks app.
 */

import { useVaultEntities } from "@brainstorm-os/react-yjs";
import { SelectMenu } from "@brainstorm-os/sdk/select-menu";
import "@brainstorm-os/sdk/select-menu.css";
import {
	WidgetEmpty,
	type WidgetLaunch,
	WidgetRoot,
	useWidgetVisible,
} from "@brainstorm-os/sdk/widget";
import { useMemo, useState } from "react";
import { t, tCount } from "./i18n/t";
import { TASK_TYPE } from "./storage/entities-repository";
import { getBrainstorm, openEntityInShell } from "./storage/runtime";
import { type TaskStatsData, computeTaskStats, dueAtOf } from "./widget-stats";
import "./widget.css";

/** Manifest widget ids — must match `registrations.widgets[].id` in manifest.json. */
export const TASKS_WIDGET_OPEN = "open-tasks";
export const TASKS_WIDGET_STATS = "task-stats";

const OPEN_LIMIT = 8;

/** Server-side narrowing for the widget's entity subscription (F-384) —
 *  module-level so the reference is stable across renders. */
const WIDGET_QUERY = { types: [TASK_TYPE] } as const;

/** Empty-state CTA (F-381): an entityType-only `open` routes to the type's
 *  registered opener and launches the full Tasks app. */
function openTasksApp(): void {
	const intents = getBrainstorm()?.services.intents;
	if (!intents) return;
	void intents.dispatch({ verb: "open", payload: { entityType: TASK_TYPE } });
}

/** How the glance list is ordered — the in-widget sort control's value set. */
enum TasksSort {
	Updated = "updated",
	Title = "title",
}

type OpenTask = { id: string; title: string };

function taskTitle(properties: Record<string, unknown>): string {
	const name = properties.name;
	return typeof name === "string" && name.trim().length > 0 ? name : t("tasks.widget.untitled");
}

/** A task is done when `completedAt` is a truthy timestamp (the canonical
 *  "is this done?" signal — see `types/task.ts`). */
function isDone(properties: Record<string, unknown>): boolean {
	const completedAt = properties.completedAt;
	return typeof completedAt === "number" && completedAt > 0;
}

function OpenTasks({
	tasks,
	total,
	sort,
	onSort,
}: {
	tasks: OpenTask[];
	total: number;
	sort: TasksSort;
	onSort: (next: TasksSort) => void;
}) {
	return (
		<div className="tasks-widget">
			<div className="tasks-widget__toolbar">
				<SelectMenu<TasksSort>
					value={sort}
					onChange={onSort}
					ariaLabel={t("tasks.widget.sort.label")}
					options={[
						{ value: TasksSort.Updated, label: t("tasks.widget.sort.updated") },
						{ value: TasksSort.Title, label: t("tasks.widget.sort.title") },
					]}
				/>
				<span className="tasks-widget__count">{tCount("tasks.widget.count", total)}</span>
			</div>
			{tasks.length === 0 ? (
				<WidgetEmpty
					message={t("tasks.widget.empty")}
					actionLabel={t("tasks.widget.emptyAction")}
					onAction={openTasksApp}
				/>
			) : (
				<ul className="tasks-widget__list">
					{tasks.map((task) => (
						<li key={task.id}>
							<button
								type="button"
								className="tasks-widget__row"
								onClick={() => void openEntityInShell({ entityId: task.id, entityType: TASK_TYPE })}
							>
								{task.title}
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function sortTasks(tasks: readonly OpenTask[], sort: TasksSort): OpenTask[] {
	// `tasks` is already ordered newest-updated-first; only Title needs a re-sort.
	if (sort !== TasksSort.Title) return [...tasks];
	return [...tasks].sort((a, b) => a.title.localeCompare(b.title));
}

function StatRow({
	count,
	label,
	tone,
	onOpen,
}: {
	count: number;
	label: string;
	tone?: "danger";
	onOpen: () => void;
}) {
	const className = `tasks-stats__row${tone ? ` tasks-stats__row--${tone}` : ""}`;
	if (count === 0) {
		return (
			<span className={`${className} tasks-stats__row--idle`}>
				<span className="tasks-stats__row-count">0</span>
				<span className="tasks-stats__row-label">{label}</span>
			</span>
		);
	}
	return (
		<button type="button" className={className} onClick={onOpen} aria-label={`${count} ${label}`}>
			<span className="tasks-stats__row-count">{count}</span>
			<span className="tasks-stats__row-label">{label}</span>
		</button>
	);
}

function TaskStats({
	stats,
	onOpen,
}: {
	stats: TaskStatsData;
	onOpen: (id: string | null) => void;
}) {
	if (stats.open.count === 0) {
		return (
			<div className="tasks-stats">
				<WidgetEmpty
					message={t("tasks.widget.stats.empty")}
					actionLabel={t("tasks.widget.emptyAction")}
					onAction={openTasksApp}
				/>
			</div>
		);
	}
	return (
		<div className="tasks-stats">
			<button
				type="button"
				className="tasks-stats__primary"
				onClick={() => onOpen(stats.open.topId)}
				aria-label={tCount("tasks.widget.count", stats.open.count)}
			>
				<span className="tasks-stats__number">{stats.open.count}</span>
				<span className="tasks-stats__primary-label">{t("tasks.widget.stats.open")}</span>
			</button>
			<div className="tasks-stats__breakdown">
				<StatRow
					count={stats.overdue.count}
					label={t("tasks.widget.stats.overdue")}
					tone="danger"
					onOpen={() => onOpen(stats.overdue.topId)}
				/>
				<StatRow
					count={stats.dueToday.count}
					label={t("tasks.widget.stats.dueToday")}
					onOpen={() => onOpen(stats.dueToday.topId)}
				/>
			</div>
		</div>
	);
}

export function TasksWidget({ launch }: { launch: WidgetLaunch }) {
	const runtime = getBrainstorm();
	// Reactive over the shell's live vault-entity index — pauses implicitly when
	// the host scrolls the widget off-screen (the surface stops re-rendering).
	useWidgetVisible();
	const [sort, setSort] = useState<TasksSort>(TasksSort.Updated);
	const { entities } = useVaultEntities(runtime?.services.vaultEntities ?? null, {
		query: WIDGET_QUERY,
	});

	const open = useMemo(
		() =>
			entities.filter((e) => e.type === TASK_TYPE && e.deletedAt === null && !isDone(e.properties)),
		[entities],
	);
	const total = open.length;

	const tasks = useMemo<OpenTask[]>(() => {
		const ordered = [...open].sort((a, b) => b.updatedAt - a.updatedAt);
		const top = ordered
			.slice(0, OPEN_LIMIT)
			.map((e) => ({ id: e.id, title: taskTitle(e.properties) }));
		return sortTasks(top, sort);
	}, [open, sort]);

	const stats = useMemo(
		() =>
			// App runtime code, so Date.now() is fine here (the pure reducer takes it).
			computeTaskStats(
				open.map((e) => ({ id: e.id, updatedAt: e.updatedAt, dueAt: dueAtOf(e.properties) })),
				Date.now(),
			),
		[open],
	);

	const openTask = (id: string | null) => {
		if (id) void openEntityInShell({ entityId: id, entityType: TASK_TYPE });
	};

	return (
		<WidgetRoot
			widgets={[
				{
					id: TASKS_WIDGET_OPEN,
					render: () => <OpenTasks tasks={tasks} total={total} sort={sort} onSort={setSort} />,
				},
				{
					id: TASKS_WIDGET_STATS,
					render: () => <TaskStats stats={stats} onOpen={openTask} />,
				},
			]}
			launch={launch}
		/>
	);
}
