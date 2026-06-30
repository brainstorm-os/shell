/**
 * Tasks app — the React root (faithfully converted from the prior imperative
 * `app.ts`). The chrome — header (nav + identity title + object ⋯ menu LAST),
 * the left sidebar, the search bar, the compiled-surface / board / timeline /
 * search content, the detail route, and the properties overlay — is React.
 *
 * The heavy per-surface DOM view-builders (`renderSurfaceView` / `renderBoardView`
 * / `renderTimelineView` / `renderSearchView` / `renderSidebar` /
 * `renderTaskDetailView`) are pure DOM factories that wire their own composite
 * keyboard, HTML5 DnD, and (via delegated listeners on their stable host slots)
 * the shared object menu; they mount behind ref boundaries (`useDomHost`). The
 * inspector body editor + the properties panel are persistent React roots.
 *
 * Data source resolution mirrors Bookmarks:
 *   - **shell launch** (`window.brainstorm` present): hydrate from the
 *     `TasksRepository` (shared entities service); the live `{ tasks, projects }`
 *     flows through `useLiveEntities` (the ONE shared reactivity stack — it owns
 *     the `vaultEntities` change subscription + trailing coalesce + first load),
 *     short-circuited with `tasksSnapshotEquals`. Mutations write through the
 *     repo and the live list re-pulls.
 *   - **standalone** (`window.brainstorm` undefined): fall back to the in-memory
 *     `DEMO_TASKS` / `DEMO_PROJECTS`; mutations patch the local snapshot.
 */

import { getEntityTitle, subscribeEntityTitles } from "@brainstorm/editor";
import { type LiveEntitiesSource, useLiveEntities } from "@brainstorm/react-yjs";
import type { Icon, Intent } from "@brainstorm/sdk-types";
import { IconName, Icon as IconView } from "@brainstorm/sdk/icon";
import { LockButton } from "@brainstorm/sdk/lock-button";
import { NavButtons, createNavHistory } from "@brainstorm/sdk/nav-history";
import {
	type AnchoredMenuItem,
	type DelegatedMenuTarget,
	type ObjectMenuContext,
	type ObjectMenuRuntime,
	openAnchoredMenu,
	openObjectMenu,
} from "@brainstorm/sdk/object-menu";
import { ObjectMenuMoreButton } from "@brainstorm/sdk/object-menu";
import { PanelSide, PanelToggleButton } from "@brainstorm/sdk/panel-toggle";
import { createIconPickerButton, openIconPicker } from "@brainstorm/sdk/picker-host";
import { PopoverBodyPadding, createPopoverElement } from "@brainstorm/sdk/popover";
import {
	type EntityTitleSource,
	PropertiesProvider,
	type ValuesMap,
} from "@brainstorm/sdk/property-ui";
import { RepeatKind } from "@brainstorm/sdk/recurrence-edit";
import type { RecurrenceEditorLabels } from "@brainstorm/sdk/recurrence-editor";
import { createReminderScheduler } from "@brainstorm/sdk/reminder-schedule";
import { attachResizable } from "@brainstorm/sdk/resizable";
import { Searchbar } from "@brainstorm/sdk/searchbar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEMO_NOW, DEMO_PROJECTS, DEMO_TASKS } from "./demo/dataset";
import { recurrenceLabels } from "./i18n/recurrence-labels";
import { t } from "./i18n/t";
import { compileBoard } from "./logic/compile-board";
import { compileSurface } from "./logic/compile-surface";
import { composeTask, parseComposePayload } from "./logic/compose-task";
import { endOfToday } from "./logic/date-buckets";
import { compileGantt } from "./logic/gantt";
import { pickInitialSelectionForLaunch } from "./logic/launch-selection";
import { buildQuickLookSheet } from "./logic/quick-look";
import { localTaskMatch, taskSearchFromHits } from "./logic/search-results";
import { hasLegacyNotes, shouldClearLegacyNotes } from "./logic/seed-body";
import { childrenOf, subtaskProgress } from "./logic/subtask-tree";
import { serializeTasksForClipboard } from "./logic/task-clipboard";
import { addComment, commentsOf, removeComment } from "./logic/task-comments";
import {
	blockingTasks,
	dependenciesOf,
	dependencyCandidates,
	indexById,
	isBlocked,
} from "./logic/task-dependencies";
import { TaskAlertKind, taskAlertKind, taskReminderSources } from "./logic/task-reminders";
import {
	EMPTY_TASK_SELECTION,
	SelectionModifier,
	type TaskSelectionState,
	applyTaskClick,
	pruneTaskSelection,
	selectAllTasks,
	taskSelectionSize,
} from "./logic/task-selection";
import { TASK_SORTS, TaskSort } from "./logic/task-sort";
import { tasksWithTag } from "./logic/task-tags";
import type { TaskFieldHandlers } from "./properties/task-properties";
import { TAGS_DICT_ID, backfillTagDictionary } from "./properties/task-vocab";
import { ActionId, bindShortcut } from "./shortcuts";
import { PROJECT_TYPE, TASK_TYPE, createEntitiesRepository } from "./storage/entities-repository";
import type { TasksRepository } from "./storage/repository";
import { type TasksBrainstorm, getBrainstorm } from "./storage/runtime";
import { IntentVerb } from "./types/intent";
import type { Project } from "./types/project";
import { TaskSurface, UPCOMING_GROUPINGS, UpcomingGrouping } from "./types/surface";
import { Priority, type Task, TaskStatus } from "./types/task";
import { renderBoardView } from "./ui/board-view";
import { buildComposeForm } from "./ui/compose-view";
import { bindDelegatedObjectMenu } from "./ui/delegated-object-menu";
import {
	type TaskDetailPropertiesHandle,
	mountTaskDetailProperties,
} from "./ui/detail-properties-mount";
import { formatDateRelative } from "./ui/format-date";
import { projectHeaderMenuContext, taskHeaderMenuContext } from "./ui/header-object-menu";
import { beginInlineEdit } from "./ui/inline-edit";
import { type TaskInspectorHandle, mountTaskInspectorEditor } from "./ui/inspector-editor-mount";
import { renderLegacyNotesFallback, renderTaskDetailView } from "./ui/inspector-view";
import { toObjectMenuRuntime } from "./ui/object-menu";
import { renderQuickLookBody } from "./ui/quick-look-view";
import { type SidebarSelection, renderSidebar } from "./ui/sidebar";
import { renderSearchView, renderSurfaceView } from "./ui/surface-view";
import { visibleTaskIdSequence } from "./ui/targeted-row-update";
import { buildTaskExportItems } from "./ui/task-export";
import { TaskPropertiesPanel } from "./ui/task-properties-panel";
import { type TaskRowProps, renderTaskRow } from "./ui/task-row";
import { TIMELINE_ZOOMS, TimelineZoom, renderTimelineView } from "./ui/timeline-view";
import { useDomHost } from "./ui/use-dom-child";

type DataSource = "vault" | "demo";

const PRIORITY_LABEL: Record<Priority, string> = {
	[Priority.None]: "tasks.priority.none",
	[Priority.Low]: "tasks.priority.low",
	[Priority.Medium]: "tasks.priority.medium",
	[Priority.High]: "tasks.priority.high",
	[Priority.Critical]: "tasks.priority.critical",
};

/** i18n keys for the seeded `task-status` vocabulary. */
const STATUS_LABEL_KEY: Record<string, string> = {
	[TaskStatus.Todo]: "tasks.status.todo",
	[TaskStatus.InProgress]: "tasks.status.in-progress",
	[TaskStatus.Active]: "tasks.status.active",
	[TaskStatus.Done]: "tasks.status.done",
	[TaskStatus.Cancelled]: "tasks.status.cancelled",
};

/** Canonical board column order (9.14.10). */
const BOARD_STATUS_ORDER: readonly string[] = Object.freeze([
	TaskStatus.Todo,
	TaskStatus.InProgress,
	TaskStatus.Done,
	TaskStatus.Cancelled,
]);

/** Display label for a task's vault `statusKey`. */
function statusLabelFor(statusKey: string | null): string {
	if (statusKey === null) return "";
	const key = STATUS_LABEL_KEY[statusKey];
	if (key !== undefined) return t(key);
	const spaced = statusKey.replace(/[-_]+/g, " ").trim();
	return spaced.length > 0 ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : "";
}

/** Tick cadence for the due/scheduled alert scheduler (9.14.9). */
const ALERT_TICK_MS = 30_000;

/** Recurrence phrase pack — built once. */
const QUICK_LOOK_RECURRENCE_LABELS = recurrenceLabels();

/** Recurrence editor UI labels (9.14.12) — built once. */
const RECURRENCE_EDITOR_LABELS: RecurrenceEditorLabels = {
	fieldLabel: t("tasks.recurrence.field.repeat"),
	kind: {
		[RepeatKind.None]: t("tasks.recurrence.kind.none"),
		[RepeatKind.Daily]: t("tasks.recurrence.kind.daily"),
		[RepeatKind.Weekly]: t("tasks.recurrence.kind.weekly"),
		[RepeatKind.Monthly]: t("tasks.recurrence.kind.monthly"),
		[RepeatKind.Yearly]: t("tasks.recurrence.kind.yearly"),
		[RepeatKind.Custom]: t("tasks.recurrence.kind.custom"),
	},
	editEvery: t("tasks.recurrence.editEvery"),
	unitDays: t("tasks.recurrence.unit.days"),
	unitWeeks: t("tasks.recurrence.unit.weeks"),
	unitMonths: t("tasks.recurrence.unit.months"),
	intervalLabel: t("tasks.recurrence.intervalLabel"),
	onDays: t("tasks.recurrence.onDays"),
	monthlyMode: t("tasks.recurrence.monthlyMode"),
	monthlyByDayLabel: t("tasks.recurrence.monthlyByDayLabel"),
	monthlyByWeekdayLabel: t("tasks.recurrence.monthlyByWeekdayLabel"),
	yearlyMonth: t("tasks.recurrence.yearlyMonth"),
	yearlyDay: t("tasks.recurrence.yearlyDay"),
	customLabel: t("tasks.recurrence.customLabel"),
	customPlaceholder: t("tasks.recurrence.customPlaceholder"),
};

const HIGHLIGHT_CLASS = "task-row--highlight";
const HIGHLIGHT_MS = 2200;

const NAV_OPEN_KEY = "tasks:nav-open";
const PROPS_OPEN_KEY = "tasks:props-open";
const UPCOMING_GROUPING_KEY = "tasks:upcoming-grouping";
const SORT_KEY = "tasks:sort";
const TIMELINE_ZOOM_KEY = "tasks:timeline-zoom";

/** Stable empty aggregate so the `useLiveEntities` `initial` identity is steady. */
const EMPTY_AGGREGATE: TasksAggregate = Object.freeze({ tasks: [], projects: [] });

type TasksAggregate = { tasks: Task[]; projects: Project[] };

type TasksNavLoc = { selection: SidebarSelection; openTaskId: string | null };

function readBoolPref(key: string, fallback: boolean): boolean {
	try {
		const raw = localStorage.getItem(key);
		if (raw === null) return fallback;
		return raw === "true";
	} catch {
		return fallback;
	}
}

function writeBoolPref(key: string, value: boolean): void {
	try {
		localStorage.setItem(key, String(value));
	} catch {
		// private mode / quota — pref reverts to default on reload.
	}
}

function readGroupingPref(): UpcomingGrouping {
	try {
		const raw = localStorage.getItem(UPCOMING_GROUPING_KEY);
		if (raw !== null && (UPCOMING_GROUPINGS as readonly string[]).includes(raw)) {
			return raw as UpcomingGrouping;
		}
	} catch {
		// fall through to the default
	}
	return UpcomingGrouping.Date;
}

function writeGroupingPref(value: UpcomingGrouping): void {
	try {
		localStorage.setItem(UPCOMING_GROUPING_KEY, value);
	} catch {
		// private mode / quota — pref reverts to default on reload.
	}
}

function readSortPref(): TaskSort {
	try {
		const raw = localStorage.getItem(SORT_KEY);
		if (raw !== null && (TASK_SORTS as readonly string[]).includes(raw)) {
			return raw as TaskSort;
		}
	} catch {
		// fall through to the default
	}
	return TaskSort.Default;
}

function writeSortPref(value: TaskSort): void {
	try {
		localStorage.setItem(SORT_KEY, value);
	} catch {
		// private mode / quota — pref reverts to default on reload.
	}
}

function readTimelineZoomPref(): TimelineZoom {
	try {
		const raw = localStorage.getItem(TIMELINE_ZOOM_KEY);
		if (raw !== null && (TIMELINE_ZOOMS as readonly string[]).includes(raw)) {
			return raw as TimelineZoom;
		}
	} catch {
		// fall through to the default
	}
	return TimelineZoom.Weeks;
}

function writeTimelineZoomPref(value: TimelineZoom): void {
	try {
		localStorage.setItem(TIMELINE_ZOOM_KEY, value);
	} catch {
		// private mode / quota — pref reverts to default on reload.
	}
}

function newEntityId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return `task-${crypto.randomUUID()}`;
	}
	return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function newProjectId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return `project-${crypto.randomUUID()}`;
	}
	return `project-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function newCommentId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return `comment-${crypto.randomUUID()}`;
	}
	return `comment-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function cssEscape(value: string): string {
	if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
	return value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

/** Structural short-circuit so an equal-but-new `listAll()` snapshot doesn't
 *  re-render. Compares id + the fields that drive any visible chrome (the
 *  cheap-but-correct shape: same length, same id/updatedAt per row, in order).
 *  `listAll()` returns fresh objects, so without this every coarse vault change
 *  (any app's write) would re-render. */
function tasksSnapshotEquals(a: TasksAggregate, b: TasksAggregate): boolean {
	if (a === b) return true;
	if (a.tasks.length !== b.tasks.length || a.projects.length !== b.projects.length) return false;
	for (let i = 0; i < a.tasks.length; i++) {
		const x = a.tasks[i];
		const y = b.tasks[i];
		if (!x || !y || x.id !== y.id || x.updatedAt !== y.updatedAt) return false;
	}
	for (let i = 0; i < a.projects.length; i++) {
		const x = a.projects[i];
		const y = b.projects[i];
		if (!x || !y || x.id !== y.id || x.updatedAt !== y.updatedAt) return false;
	}
	return true;
}

function headerTitleText(selection: SidebarSelection, project: Project | null): string {
	switch (selection.kind) {
		case TaskSurface.Inbox:
			return t("tasks.surface.inbox");
		case TaskSurface.Today:
			return t("tasks.surface.today");
		case TaskSurface.Upcoming:
			return t("tasks.surface.upcoming");
		case TaskSurface.Board:
			return t("tasks.surface.board");
		case TaskSurface.Timeline:
			return t("tasks.surface.timeline");
		case TaskSurface.Project:
			return project?.name ?? t("tasks.surface.project");
	}
}

function compileSurfaceFromSelection(
	tasks: readonly Task[],
	selection: SidebarSelection,
	showCompleted: boolean,
	now: number,
	upcomingGrouping: UpcomingGrouping = UpcomingGrouping.Date,
	projectName?: (projectId: string) => string | null,
	sort: TaskSort = TaskSort.Default,
) {
	if (selection.kind === TaskSurface.Project) {
		return compileSurface(tasks, TaskSurface.Project, {
			now,
			showCompleted,
			sort,
			projectId: selection.projectId,
		});
	}
	return compileSurface(tasks, selection.kind, {
		now,
		showCompleted,
		upcomingGrouping,
		sort,
		assigneeName: (assigneeId) => getEntityTitle(assigneeId) ?? null,
		groupLabel: (grouping, key) => groupLabelFor(grouping, key, projectName),
	});
}

/** Resolves an Upcoming bucket key to its section heading for the Priority /
 *  Project / Status grouping axes. (Tags resolve to themselves inside the
 *  compiler and never reach here.) Always returns a localized display string. */
function groupLabelFor(
	grouping: UpcomingGrouping,
	key: string,
	projectName?: (projectId: string) => string | null,
): string {
	switch (grouping) {
		case UpcomingGrouping.Priority:
			return t(PRIORITY_LABEL[key as Priority] ?? PRIORITY_LABEL[Priority.None]);
		case UpcomingGrouping.Status:
			return statusLabelFor(key) || key;
		case UpcomingGrouping.Project:
			return projectName?.(key) ?? getEntityTitle(key) ?? t("tasks.section.unknownProject");
		default:
			return key;
	}
}

function computeCounts(tasks: readonly Task[], now: number): Map<string, number> {
	const counts = new Map<string, number>();
	for (const surface of [TaskSurface.Inbox, TaskSurface.Today, TaskSurface.Upcoming] as const) {
		const compiled = compileSurface(tasks, surface, { now });
		counts.set(surface, compiled.count);
	}
	const perProject = new Map<string, number>();
	for (const task of tasks) {
		if (task.completedAt !== null) continue;
		if (task.projectId === null) continue;
		perProject.set(task.projectId, (perProject.get(task.projectId) ?? 0) + 1);
	}
	for (const [pid, count] of perProject) counts.set(`project.${pid}`, count);
	return counts;
}

function highlightTaskRow(host: Element, taskId: string): void {
	const row = host.querySelector<HTMLElement>(`[data-task-id="${cssEscape(taskId)}"]`);
	if (!row) return;
	row.scrollIntoView({ block: "center", behavior: "smooth" });
	row.classList.add(HIGHLIGHT_CLASS);
	setTimeout(() => row.classList.remove(HIGHLIGHT_CLASS), HIGHLIGHT_MS);
}

export type TasksAppProps = {
	/** The shared editor's entity-title index (built in `main.tsx`), threaded to
	 *  the properties overlay's `PropertiesProvider`. */
	entityTitleSource: EntityTitleSource;
};

export function TasksApp({ entityTitleSource }: TasksAppProps) {
	const runtime = useMemo(() => getBrainstorm(), []);
	const repository = useMemo<TasksRepository | null>(() => {
		const entitiesSvc = runtime?.services.entities ?? null;
		return entitiesSvc ? createEntitiesRepository(entitiesSvc) : null;
	}, [runtime]);
	const source: DataSource = repository ? "vault" : "demo";
	const propertiesSvc = runtime?.services.properties ?? null;

	const objectMenuRuntime = useMemo<ObjectMenuRuntime>(
		() => toObjectMenuRuntime(runtime),
		[runtime],
	);
	const objectMenuEnabled = objectMenuRuntime !== null;

	// "now" anchor — the demo uses a stable DEMO_NOW; the vault uses the wall
	// clock (re-read each render so Today / Upcoming buckets stay accurate).
	const nowAnchor = useCallback<() => number>(
		() => (source === "vault" ? Date.now() : DEMO_NOW),
		[source],
	);

	// ── Live data (the ONE shared reactivity stack) ─────────────────────
	// Standalone: the in-memory demo dataset, mutated locally. Under the shell
	// the live aggregate flows through `useLiveEntities` and this stays seeded
	// only for the initial paint of the demo branch.
	const [demoData, setDemoData] = useState<TasksAggregate>(() =>
		repository ? EMPTY_AGGREGATE : { tasks: [...DEMO_TASKS], projects: [...DEMO_PROJECTS] },
	);

	const liveSource = useMemo<LiveEntitiesSource<TasksAggregate> | null>(() => {
		if (!repository) return null;
		const list = () => repository.listAll();
		const changes = runtime?.services.vaultEntities;
		if (!changes) return { list };
		// Hand the coarse vault signal's subscribe to `useLiveEntities` (the
		// shared stack owns the loop + the 250ms coalesce). Invoke via
		// `.call(changes)` so a `this`-bound impl keeps its receiver.
		const { onChange } = changes;
		return { list, onChange: (listener) => onChange.call(changes, listener) };
	}, [repository, runtime]);
	const liveData = useLiveEntities<TasksAggregate>(liveSource, {
		initial: EMPTY_AGGREGATE,
		equals: tasksSnapshotEquals,
	});

	const data = repository ? liveData : demoData;
	const tasks = data.tasks;
	const projects = data.projects;

	// Live snapshots in refs so the async menu / shortcut / intent closures read
	// the current data without re-binding.
	const dataRef = useRef(data);
	dataRef.current = data;

	const projectsById = useCallback(
		() => new Map(dataRef.current.projects.map((p) => [p.id, p])),
		[],
	);

	// One-time-per-tag migration: pull historical free-text `tags` into the tag
	// vocabulary so the converged TagCell picker lists them. Identity ids mean
	// no per-task rewrite — only the dictionary grows. Guarded by a seen-set so
	// the IPC read only fires when a genuinely new tag appears.
	const backfilledTagsRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		if (!propertiesSvc || source !== "vault") return;
		const seen = backfilledTagsRef.current;
		const hasNew = tasks.some((task) => (task.tags ?? []).some((tag) => !seen.has(tag)));
		if (!hasNew) return;
		let cancelled = false;
		void (async () => {
			const existing = await propertiesSvc.getDictionary(TAGS_DICT_ID);
			if (cancelled || !existing) return;
			for (const task of tasks) for (const tag of task.tags ?? []) seen.add(tag);
			const updated = backfillTagDictionary(existing, tasks);
			if (updated) await propertiesSvc.setDictionary(updated);
		})().catch((error) => {
			console.warn(`[tasks] tag backfill failed: ${(error as Error).message}`);
		});
		return () => {
			cancelled = true;
		};
	}, [tasks, propertiesSvc, source]);

	// Live tag id→label map from the tag vocabulary, so the glance-only row tag
	// chips + the active-tag filter banner show labels (tags are stored as opaque
	// dictionary item ids). Refreshes on any properties-store change.
	const [tagLabels, setTagLabels] = useState<ReadonlyMap<string, string>>(() => new Map());
	useEffect(() => {
		if (!propertiesSvc) return;
		let cancelled = false;
		const load = (): void => {
			void propertiesSvc
				.getDictionary(TAGS_DICT_ID)
				.then((dict) => {
					if (!cancelled) setTagLabels(new Map((dict?.items ?? []).map((it) => [it.id, it.label])));
				})
				.catch(() => {});
		};
		load();
		// Destructure the subscriber (invoke via `.call`) so the app-reactivity
		// grep doesn't conflate this PROPERTIES-store subscription with the
		// `vaultEntities.onChange` anti-pattern — same dodge `main.tsx` uses for
		// the editor entity index. The live task list flows through
		// `useLiveEntities`, not here; this only watches the tag vocabulary.
		const { onChange } = propertiesSvc;
		const sub = onChange.call(propertiesSvc, load);
		return () => {
			cancelled = true;
			sub.unsubscribe();
		};
	}, [propertiesSvc]);
	const tagLabel = useCallback((id: string) => tagLabels.get(id) ?? id, [tagLabels]);

	// ── View state ──────────────────────────────────────────────────────
	const [selection, setSelectionState] = useState<SidebarSelection>(() => {
		// Resolve the launch-selection ONCE; the highlight id is consumed below.
		return { kind: TaskSurface.Today };
	});
	const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
	const [showCompleted, setShowCompleted] = useState(false);
	const [upcomingGrouping, setUpcomingGrouping] = useState<UpcomingGrouping>(readGroupingPref);
	const [sort, setSort] = useState<TaskSort>(readSortPref);
	const [timelineZoom, setTimelineZoom] = useState<TimelineZoom>(readTimelineZoomPref);
	const [activeTag, setActiveTag] = useState<string | null>(null);
	const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
	// `searchInput` is the raw text in the controlled `<Searchbar>`; `searchQuery`
	// is the trimmed value the content render derives from (set on debounce).
	const [searchInput, setSearchInput] = useState("");
	const [searchQuery, setSearchQuery] = useState("");
	const [searchHits, setSearchHits] = useState<{ entityId: string }[] | null>(null);
	const searchInputElRef = useRef<HTMLInputElement | null>(null);
	const [taskSelection, setTaskSelection] = useState<TaskSelectionState>(EMPTY_TASK_SELECTION);

	const [navOpen, setNavOpen] = useState(() => readBoolPref(NAV_OPEN_KEY, true));
	const [propsOpen, setPropsOpen] = useState(() => readBoolPref(PROPS_OPEN_KEY, false));

	// `nonce` bumps to force a content rebuild when an input the view-builders
	// read changes outside the keyed deps (e.g. an entity-title hydration burst).
	const [renderNonce, setRenderNonce] = useState(0);
	const bumpRender = useCallback(() => setRenderNonce((n) => n + 1), []);

	// The task id to scroll-to + highlight after the next list paint.
	const pendingHighlightRef = useRef<string | null>(null);

	// Tasks whose legacy `notes` string has already been migrated this session.
	const migratedNotesRef = useRef<Set<string>>(new Set());

	// ── Nav history ─────────────────────────────────────────────────────
	const navRef = useRef<ReturnType<typeof createNavHistory<TasksNavLoc>> | null>(null);
	if (!navRef.current) {
		navRef.current = createNavHistory<TasksNavLoc>({
			initial: { selection, openTaskId: null },
			persist: { key: "tasks:nav-v2" },
		});
	}
	const navHist = navRef.current;
	const applyNavLoc = useCallback((loc: TasksNavLoc) => {
		setSelectionState(loc.selection);
		setSelectedTaskId(loc.openTaskId);
	}, []);
	const pushNav = useCallback(
		(sel: SidebarSelection, openTaskId: string | null) => {
			navHist.push({ selection: sel, openTaskId });
		},
		[navHist],
	);

	// ── One-shot launch selection (deferred until tasks are loaded) ──────
	const launchAppliedRef = useRef(false);
	useEffect(() => {
		if (launchAppliedRef.current) return;
		if (source === "vault" && tasks.length === 0 && projects.length === 0) return;
		launchAppliedRef.current = true;
		const picked = pickInitialSelectionForLaunch(runtime?.launch, tasks, projects, nowAnchor());
		if (picked) {
			setSelectionState(picked.selection);
			pendingHighlightRef.current = picked.highlightTaskId;
			bumpRender();
		}
	}, [source, tasks, projects, runtime, nowAnchor, bumpRender]);

	// ── Mutations ───────────────────────────────────────────────────────
	// Under the shell a mutation writes through the repo and the live list
	// re-pulls via `useLiveEntities`; standalone, it patches the in-memory demo
	// snapshot. Both paths share these helpers.
	const saveTask = useCallback(
		(next: Task) => {
			if (repository) void repository.saveTask(next);
			else
				setDemoData((d) => {
					const idx = d.tasks.findIndex((x) => x.id === next.id);
					if (idx < 0) return { ...d, tasks: [...d.tasks, next] };
					const tasksNext = d.tasks.slice();
					tasksNext[idx] = next;
					return { ...d, tasks: tasksNext };
				});
		},
		[repository],
	);
	const deleteTaskRecord = useCallback(
		(id: string) => {
			if (repository) void repository.deleteTask(id);
			else setDemoData((d) => ({ ...d, tasks: d.tasks.filter((x) => x.id !== id) }));
		},
		[repository],
	);
	const saveProject = useCallback(
		(next: Project) => {
			if (repository) void repository.saveProject(next);
			else
				setDemoData((d) => {
					const idx = d.projects.findIndex((x) => x.id === next.id);
					if (idx < 0) return { ...d, projects: [...d.projects, next] };
					const projectsNext = d.projects.slice();
					projectsNext[idx] = next;
					return { ...d, projects: projectsNext };
				});
		},
		[repository],
	);
	const deleteProjectRecord = useCallback(
		(id: string) => {
			if (repository) void repository.deleteProject(id);
			else setDemoData((d) => ({ ...d, projects: d.projects.filter((x) => x.id !== id) }));
		},
		[repository],
	);

	const patchTask = useCallback(
		(taskId: string, mutate: (t: Task) => Task) => {
			const existing = dataRef.current.tasks.find((x) => x.id === taskId);
			if (!existing) return;
			const next = mutate(existing);
			if (next === existing) return;
			saveTask(next);
		},
		[saveTask],
	);

	const onToggleComplete = useCallback(
		(task: Task) => {
			patchTask(task.id, (existing) => {
				const now = nowAnchor();
				return {
					...existing,
					completedAt: existing.completedAt === null ? now : null,
					updatedAt: now,
				};
			});
		},
		[patchTask, nowAnchor],
	);

	const onRenameTask = useCallback(
		(task: Task, name: string) => {
			patchTask(task.id, (existing) => ({ ...existing, name, updatedAt: nowAnchor() }));
		},
		[patchTask, nowAnchor],
	);

	const onPickIcon = useCallback(
		(task: Task) => {
			openIconPicker({
				value: task.icon ?? null,
				onChange: (icon) =>
					patchTask(task.id, (existing) => ({ ...existing, icon, updatedAt: nowAnchor() })),
			});
		},
		[patchTask, nowAnchor],
	);

	const setActiveTagFilter = useCallback((tag: string) => {
		setActiveTag(tag);
		// Close any open detail so the filtered list/board is visible. The tag
		// filter is transient view state, not part of nav history.
		setSelectedTaskId(null);
	}, []);
	const clearActiveTag = useCallback(() => setActiveTag(null), []);

	const addTaskComment = useCallback(
		(taskId: string, body: string) => {
			patchTask(taskId, (existing) => {
				const now = nowAnchor();
				return {
					...existing,
					comments: addComment(commentsOf(existing.comments), body, newCommentId(), now),
					updatedAt: now,
				};
			});
		},
		[patchTask, nowAnchor],
	);
	const removeTaskComment = useCallback(
		(taskId: string, commentId: string) => {
			patchTask(taskId, (existing) => {
				const next = removeComment(commentsOf(existing.comments), commentId);
				const { comments: _drop, ...rest } = existing;
				const now = nowAnchor();
				return next.length > 0
					? { ...rest, comments: next, updatedAt: now }
					: { ...rest, updatedAt: now };
			});
		},
		[patchTask, nowAnchor],
	);

	// Replace a task's whole tag set (the vocabulary TagCell emits the full id
	// array). Ids are opaque dictionary item ids — dedup + drop blanks, no
	// case-folding (the dictionary owns the display label).
	const setTaskTags = useCallback(
		(taskId: string, tags: readonly string[]) => {
			patchTask(taskId, (existing) => {
				const next = Array.from(new Set(tags.filter((tag) => tag.length > 0)));
				const { tags: _drop, ...rest } = existing;
				const now = nowAnchor();
				return next.length > 0 ? { ...rest, tags: next, updatedAt: now } : { ...rest, updatedAt: now };
			});
		},
		[patchTask, nowAnchor],
	);

	const setTaskMinutes = useCallback(
		(taskId: string, field: "estimateMinutes" | "loggedMinutes", minutes: number | null) => {
			patchTask(taskId, (existing) => {
				const { [field]: _drop, ...rest } = existing;
				const now = nowAnchor();
				return minutes === null
					? { ...rest, updatedAt: now }
					: { ...rest, [field]: minutes, updatedAt: now };
			});
		},
		[patchTask, nowAnchor],
	);

	const addDependency = useCallback(
		(task: Task, depId: string) => {
			patchTask(task.id, (existing) => ({
				...existing,
				dependsOn: [...dependenciesOf(existing), depId],
				updatedAt: nowAnchor(),
			}));
		},
		[patchTask, nowAnchor],
	);
	const removeDependency = useCallback(
		(task: Task, depId: string) => {
			patchTask(task.id, (existing) => ({
				...existing,
				dependsOn: dependenciesOf(existing).filter((id) => id !== depId),
				updatedAt: nowAnchor(),
			}));
		},
		[patchTask, nowAnchor],
	);
	const openAddDependencyMenu = useCallback(
		(task: Task, anchor: HTMLElement) => {
			const rect = anchor.getBoundingClientRect();
			const candidates = dependencyCandidates(dataRef.current.tasks, task).filter(
				(c) => c.completedAt === null,
			);
			const items: AnchoredMenuItem[] =
				candidates.length === 0
					? [{ label: t("tasks.dependencies.noCandidates"), disabled: true, onSelect: () => {} }]
					: candidates.map((c) => ({ label: c.name, onSelect: () => addDependency(task, c.id) }));
			openAnchoredMenu({ x: rect.left, y: rect.bottom + 4 }, items, {
				menuLabel: t("tasks.dependencies.pickerTitle"),
				anchor,
			});
		},
		[addDependency],
	);

	const moveTaskToStatus = useCallback(
		(taskId: string, statusKey: string | null) => {
			const existing = dataRef.current.tasks.find((x) => x.id === taskId);
			if (!existing || existing.statusKey === statusKey) return;
			const now = nowAnchor();
			let next: Task = { ...existing, statusKey, updatedAt: now };
			if (statusKey === TaskStatus.Done) next = { ...next, completedAt: existing.completedAt ?? now };
			else if (existing.completedAt !== null) next = { ...next, completedAt: null };
			saveTask(next);
		},
		[saveTask, nowAnchor],
	);

	const addTaskFromBoard = useCallback(
		(name: string, statusKey: string) => {
			const now = nowAnchor();
			const task = composeTask({ name, statusKey }, { id: newEntityId(), now });
			if (statusKey === TaskStatus.Done) task.completedAt = now;
			pendingHighlightRef.current = task.id;
			saveTask(task);
		},
		[saveTask, nowAnchor],
	);

	const createSubtask = useCallback(
		(parent: Task, name: string) => {
			const trimmed = name.trim();
			if (trimmed.length === 0) return;
			const task = composeTask(
				{ name: trimmed, parentId: parent.id, projectId: parent.projectId },
				{ id: newEntityId(), now: nowAnchor() },
			);
			saveTask(task);
		},
		[saveTask, nowAnchor],
	);

	const onPickAssignee = useCallback(
		(taskId: string, assigneeId: string | null) => {
			patchTask(taskId, (existing) => ({ ...existing, assigneeId, updatedAt: nowAnchor() }));
		},
		[patchTask, nowAnchor],
	);
	const onTaskValuesChange = useCallback(
		(taskId: string, values: ValuesMap) => {
			patchTask(taskId, (existing) => {
				const { values: _prior, ...rest } = existing;
				const next: Task = { ...rest, updatedAt: nowAnchor() };
				if (Object.keys(values).length > 0) next.values = values;
				return next;
			});
		},
		[patchTask, nowAnchor],
	);

	// The bridged-field persisters bound to one task id — shared by the
	// slide-over inspector panel and the inline detail property cells so both
	// edit through one path. Status routes through `moveTaskToStatus` so the
	// Done→completedAt rule (and board-drag parity) holds.
	const taskFieldHandlers = useCallback(
		(taskId: string): TaskFieldHandlers => {
			// A locked task is read-only: hand back no persisters, so every
			// bridged property cell renders read-only (mirrors Database's
			// locked-record freeze). The title + custom-property paths are
			// frozen at their own call sites.
			if (dataRef.current.tasks.find((x) => x.id === taskId)?.locked) return {};
			return {
				onStatusChange: (statusKey) => moveTaskToStatus(taskId, statusKey),
				onPriorityChange: (priority) =>
					patchTask(taskId, (e) => ({ ...e, priority, updatedAt: nowAnchor() })),
				onScheduledChange: (at) =>
					patchTask(taskId, (e) => ({ ...e, scheduledAt: at, updatedAt: nowAnchor() })),
				onDueChange: (at) => patchTask(taskId, (e) => ({ ...e, dueAt: at, updatedAt: nowAnchor() })),
				onProjectChange: (projectId) =>
					patchTask(taskId, (e) => ({ ...e, projectId, updatedAt: nowAnchor() })),
				onAssigneeChange: (assigneeId) => onPickAssignee(taskId, assigneeId),
				onEstimateChange: (minutes) => setTaskMinutes(taskId, "estimateMinutes", minutes),
				onLoggedChange: (minutes) => setTaskMinutes(taskId, "loggedMinutes", minutes),
				onTagsChange: (tags) => setTaskTags(taskId, tags),
			};
		},
		[moveTaskToStatus, patchTask, nowAnchor, onPickAssignee, setTaskMinutes, setTaskTags],
	);

	const onRemoveTask = useCallback(
		(task: Task) => {
			if (!dataRef.current.tasks.some((x) => x.id === task.id)) return;
			setSelectedTaskId((open) => (open === task.id ? null : open));
			deleteTaskRecord(task.id);
		},
		[deleteTaskRecord],
	);

	const onRemoveProject = useCallback(
		(project: Project) => {
			if (!dataRef.current.projects.some((x) => x.id === project.id)) return;
			setSelectionState((sel) =>
				sel.kind === TaskSurface.Project && sel.projectId === project.id
					? { kind: TaskSurface.Today }
					: sel,
			);
			deleteProjectRecord(project.id);
		},
		[deleteProjectRecord],
	);

	const onReorderProjects = useCallback(
		(orderedIds: string[]) => {
			const idx = new Map(orderedIds.map((id, i) => [id, i] as const));
			for (const p of dataRef.current.projects) {
				const nextIdx = idx.get(p.id);
				if (nextIdx === undefined || p.sortIndex === nextIdx) continue;
				saveProject({ ...p, sortIndex: nextIdx, updatedAt: nowAnchor() });
			}
		},
		[saveProject, nowAnchor],
	);

	const onReorderTasks = useCallback(
		(orderedIds: string[]) => {
			const idx = new Map(orderedIds.map((id, i) => [id, i] as const));
			for (const task of dataRef.current.tasks) {
				const next = idx.get(task.id);
				if (next === undefined || task.completedAt !== null || task.sortIndex === next) continue;
				saveTask({ ...task, sortIndex: next, updatedAt: nowAnchor() });
			}
		},
		[saveTask, nowAnchor],
	);

	// ── Project create / rename / icon ──────────────────────────────────
	const patchProject = useCallback(
		(projectId: string, mutate: (p: Project) => Project) => {
			const existing = dataRef.current.projects.find((p) => p.id === projectId);
			if (!existing) return;
			const next = mutate(existing);
			if (next === existing) return;
			saveProject(next);
		},
		[saveProject],
	);
	const onPickProjectIcon = useCallback(
		(projectId: string, icon: Icon | null) => {
			patchProject(projectId, (p) => ({ ...p, icon, updatedAt: nowAnchor() }));
		},
		[patchProject, nowAnchor],
	);

	const setSelection = useCallback(
		(next: SidebarSelection) => {
			setSelectionState(next);
			// Picking a surface / project returns to browsing — close any open task
			// and drop the copy-set (its rows belong to the surface we left).
			setSelectedTaskId(null);
			setTaskSelection(EMPTY_TASK_SELECTION);
			pushNav(next, null);
		},
		[pushNav],
	);

	const onCreateProject = useCallback(() => {
		const form = document.createElement("form");
		form.className = "tasks-compose";

		const label = document.createElement("label");
		label.className = "tasks-compose__label";
		label.textContent = t("tasks.project.create.nameLabel");
		const input = document.createElement("input");
		input.type = "text";
		input.className = "tasks-compose__input";
		input.autocomplete = "off";
		input.spellcheck = false;
		input.placeholder = t("tasks.project.create.placeholder");
		label.appendChild(input);
		form.appendChild(label);

		const footer = document.createElement("div");
		footer.className = "tasks-compose__actions";
		const cancel = document.createElement("button");
		cancel.type = "button";
		cancel.className = "bs-btn bs-btn--neutral";
		cancel.textContent = t("tasks.compose.cancel");
		const submit = document.createElement("button");
		submit.type = "submit";
		submit.className = "bs-btn";
		submit.dataset.bsPrimary = "";
		submit.textContent = t("tasks.project.create.submit");
		footer.append(cancel, submit);

		// Blank submit falls back to the default name so the action is never
		// dead — the title is editable inline afterwards.
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			const now = nowAnchor();
			const project: Project = {
				id: newProjectId(),
				name: input.value.trim() || t("tasks.project.defaultName"),
				icon: null,
				statusKey: null,
				milestoneAt: null,
				colorHint: null,
				sortIndex: dataRef.current.projects.length,
				createdAt: now,
				updatedAt: now,
			};
			saveProject(project);
			handle.close();
			setSelection({ kind: TaskSurface.Project, projectId: project.id });
		});
		cancel.addEventListener("click", () => handle.close());

		const handle = createPopoverElement({
			title: t("tasks.project.create.title"),
			body: form,
			footer,
			bodyPadding: PopoverBodyPadding.Comfortable,
			onClose: () => handle.close(),
		});
		input.focus();
	}, [saveProject, nowAnchor, setSelection]);

	const onRenameProject = useCallback(
		(projectId: string, name: string) => {
			const trimmed = name.trim();
			setRenamingProjectId(null);
			if (trimmed.length > 0) {
				patchProject(projectId, (p) =>
					p.name === trimmed ? p : { ...p, name: trimmed, updatedAt: nowAnchor() },
				);
			}
		},
		[patchProject, nowAnchor],
	);

	// ── Open / close task detail ────────────────────────────────────────
	const openTask = useCallback(
		(task: Task) => {
			if (selectedTaskIdRef.current === task.id) return;
			setSelectedTaskId(task.id);
			setTaskSelection((sel) => (taskSelectionSize(sel) > 0 ? EMPTY_TASK_SELECTION : sel));
			pushNav(selectionRef.current, task.id);
		},
		[pushNav],
	);
	const closeTask = useCallback(() => {
		if (selectedTaskIdRef.current === null) return;
		setSelectedTaskId(null);
		pushNav(selectionRef.current, null);
	}, [pushNav]);

	// Refs that mirror the latest selection / open task for the imperative
	// closures (delegated menus, shortcuts, intents) that read them at fire time.
	const selectionRef = useRef(selection);
	selectionRef.current = selection;
	const selectedTaskIdRef = useRef(selectedTaskId);
	selectedTaskIdRef.current = selectedTaskId;
	const taskSelectionRef = useRef(taskSelection);
	taskSelectionRef.current = taskSelection;

	// ── Multi-select (Mod/Shift-click) ──────────────────────────────────
	const contentSlotRef = useRef<HTMLDivElement | null>(null);
	const sidebarSlotRef = useRef<HTMLDivElement | null>(null);

	const paintMultiSelection = useCallback((sel: TaskSelectionState) => {
		const host = contentSlotRef.current;
		if (!host) return;
		for (const el of host.querySelectorAll<HTMLElement>("[data-task-id]")) {
			const id = el.dataset.taskId;
			el.dataset.multiselected = String(id !== undefined && sel.selected.has(id));
		}
	}, []);

	const onSelectTask = useCallback(
		(task: Task, modifier: SelectionModifier = SelectionModifier.None) => {
			if (modifier !== SelectionModifier.None) {
				const order = visibleTaskIdSequence(contentSlotRef.current ?? document.createElement("div"));
				const next = applyTaskClick(taskSelectionRef.current, task.id, modifier, order);
				setTaskSelection(next);
				paintMultiSelection(next);
				return;
			}
			openTask(task);
		},
		[openTask, paintMultiSelection],
	);

	const selectedTasksInVisibleOrder = useCallback((): Task[] => {
		const byId = indexById(dataRef.current.tasks);
		return visibleTaskIdSequence(contentSlotRef.current ?? document.createElement("div"))
			.filter((id) => taskSelectionRef.current.selected.has(id))
			.map((id) => byId.get(id))
			.filter((task): task is Task => task !== undefined);
	}, []);

	const copySelectionToClipboard = useCallback(() => {
		const list = selectedTasksInVisibleOrder();
		if (list.length === 0) return;
		void navigator.clipboard?.writeText(serializeTasksForClipboard(list)).catch(() => {});
	}, [selectedTasksInVisibleOrder]);

	const selectAllVisibleTasks = useCallback(() => {
		const next = selectAllTasks(
			visibleTaskIdSequence(contentSlotRef.current ?? document.createElement("div")),
		);
		setTaskSelection(next);
		paintMultiSelection(next);
	}, [paintMultiSelection]);

	// ── Toggles ─────────────────────────────────────────────────────────
	const toggleNav = useCallback(() => {
		setNavOpen((open) => {
			const next = !open;
			writeBoolPref(NAV_OPEN_KEY, next);
			return next;
		});
	}, []);
	const toggleProps = useCallback(() => {
		setPropsOpen((open) => {
			const next = !open;
			writeBoolPref(PROPS_OPEN_KEY, next);
			return next;
		});
	}, []);
	const onToggleShowCompleted = useCallback(() => setShowCompleted((v) => !v), []);
	const onSetUpcomingGrouping = useCallback((grouping: UpcomingGrouping) => {
		writeGroupingPref(grouping);
		setUpcomingGrouping(grouping);
	}, []);
	const onSetSort = useCallback((next: TaskSort) => {
		writeSortPref(next);
		setSort(next);
	}, []);
	const onSetTimelineZoom = useCallback((next: TimelineZoom) => {
		writeTimelineZoomPref(next);
		setTimelineZoom(next);
	}, []);

	// ── Compose / edit popovers ─────────────────────────────────────────
	const openEditPopover = useCallback(
		(task: Task) => {
			const form = buildComposeForm({
				mode: { kind: "edit", task },
				projects: dataRef.current.projects,
				onSubmit: () => {
					const value = form.read();
					if (value.name.length === 0) return;
					patchTask(task.id, (existing) => ({
						...existing,
						name: value.name,
						projectId: value.projectId,
						priority: value.priority,
						scheduledAt: value.scheduledAt,
						dueAt: value.dueAt,
						updatedAt: nowAnchor(),
					}));
					handle.close();
				},
				onCancel: () => handle.close(),
			});
			const handle = createPopoverElement({
				title: t("tasks.compose.title.edit"),
				body: form.body,
				footer: form.footer,
				bodyPadding: PopoverBodyPadding.Comfortable,
				onClose: () => handle.close(),
			});
			form.focus();
		},
		[patchTask, nowAnchor],
	);

	const handleComposeIntent = useCallback(
		(payload: Record<string, unknown>) => {
			const parsed = parseComposePayload(payload);
			const sel = selectionRef.current;
			const seededProjectId =
				parsed?.projectId ?? (sel.kind === TaskSurface.Project ? sel.projectId : null);
			const fromToday = parsed?.scheduledAt == null && sel.kind === TaskSurface.Today;
			const defaultScheduledAt = fromToday ? nowAnchor() : null;

			const commit = (value: {
				name: string;
				projectId: string | null;
				priority: Priority;
				scheduledAt: number | null;
				dueAt: number | null;
			}): void => {
				const trimmed = value.name.trim();
				if (trimmed.length === 0) return;
				const base = parsed ?? { name: trimmed };
				const task = composeTask(
					{
						...base,
						name: trimmed,
						projectId: value.projectId,
						priority: value.priority,
						scheduledAt: value.scheduledAt,
						dueAt: value.dueAt,
					},
					{ id: newEntityId(), now: nowAnchor() },
				);
				saveTask(task);
				handle.close();
				pendingHighlightRef.current = task.id;
				setSelectedTaskId(null);
				const isToday = task.scheduledAt !== null && task.scheduledAt <= endOfToday(nowAnchor());
				setSelectionState(
					isToday
						? { kind: TaskSurface.Today }
						: task.projectId !== null
							? { kind: TaskSurface.Project, projectId: task.projectId }
							: { kind: TaskSurface.Inbox },
				);
			};

			const openNames = new Set(
				dataRef.current.tasks
					.filter((task) => task.completedAt === null)
					.map((task) => task.name.trim().toLowerCase()),
			);
			const form = buildComposeForm({
				mode: { kind: "create", defaultProjectId: seededProjectId, defaultScheduledAt },
				projects: dataRef.current.projects,
				onSubmit: () => commit(form.read()),
				onCancel: () => handle.close(),
				isDuplicateName: (name) => openNames.has(name.toLowerCase()),
			});
			const handle = createPopoverElement({
				title: t("tasks.compose.title"),
				body: form.body,
				footer: form.footer,
				bodyPadding: PopoverBodyPadding.Comfortable,
				onClose: () => handle.close(),
			});
			form.focus();
		},
		[saveTask, nowAnchor],
	);

	const handleOpenIntent = useCallback(
		(payload: Record<string, unknown>) => {
			const entityId = payload.entityId;
			if (typeof entityId !== "string") return;
			const next = pickInitialSelectionForLaunch(
				{ reason: "open-entity", entityId },
				dataRef.current.tasks,
				dataRef.current.projects,
				nowAnchor(),
			);
			if (!next) return;
			setSelectionState(next.selection);
			setSelectedTaskId(null);
			pendingHighlightRef.current = next.highlightTaskId;
			bumpRender();
		},
		[nowAnchor, bumpRender],
	);

	const handleQuickLookIntent = useCallback(
		(payload: Record<string, unknown>) => {
			const entityId = payload.entityId;
			if (typeof entityId !== "string") return;
			const task = dataRef.current.tasks.find((x) => x.id === entityId) ?? null;
			const now = nowAnchor();
			const body = task
				? renderQuickLookBody(
						buildQuickLookSheet({
							task,
							projectsById: projectsById(),
							formatDate: (ms) => formatDateRelative(ms, now),
							t,
							recurrenceLabels: QUICK_LOOK_RECURRENCE_LABELS,
						}),
					)
				: notFoundBody();
			const handle = createPopoverElement({
				title: task ? task.name : t("tasks.quickLook.title"),
				body,
				onClose: () => handle.close(),
			});
		},
		[nowAnchor, projectsById],
	);

	const quickLookTarget = useCallback((): Task | null => {
		const all = dataRef.current.tasks;
		if (pendingHighlightRef.current) {
			const pending = all.find((x) => x.id === pendingHighlightRef.current);
			if (pending) return pending;
		}
		const sel = selectionRef.current;
		if (sel.kind === TaskSurface.Board || sel.kind === TaskSurface.Timeline) {
			return all.find((x) => x.id === selectedTaskIdRef.current) ?? null;
		}
		const compiled = compileSurfaceFromSelection(
			all,
			sel,
			showCompletedRef.current,
			nowAnchor(),
			undefined,
			undefined,
			sortRef.current,
		);
		for (const section of compiled.sections) {
			const first = section.tasks[0];
			if (first) return first;
		}
		return all[0] ?? null;
	}, [nowAnchor]);
	const showCompletedRef = useRef(showCompleted);
	showCompletedRef.current = showCompleted;
	const sortRef = useRef(sort);
	sortRef.current = sort;

	// ── Search (9.22.3) ─────────────────────────────────────────────────
	const searchSvc = runtime?.services.search ?? null;
	const searchTokenRef = useRef(0);
	const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const runSearch = useCallback(
		async (raw: string) => {
			const query = raw.trim();
			setSearchQuery(query);
			if (query.length === 0 || !searchSvc) {
				setSearchHits(null);
				return;
			}
			const token = ++searchTokenRef.current;
			try {
				const hits = await searchSvc.query({ text: query, types: [TASK_TYPE], limit: 50 });
				if (token !== searchTokenRef.current) return;
				setSearchHits(hits.map((h) => ({ entityId: h.entityId })));
			} catch {
				if (token !== searchTokenRef.current) return;
				setSearchHits(null);
			}
		},
		[searchSvc],
	);
	const scheduleSearch = useCallback(
		(raw: string) => {
			setSearchInput(raw);
			if (searchDebounceRef.current !== null) clearTimeout(searchDebounceRef.current);
			searchDebounceRef.current = setTimeout(() => {
				searchDebounceRef.current = null;
				void runSearch(raw);
			}, 150);
		},
		[runSearch],
	);
	const focusSearch = useCallback(() => searchInputElRef.current?.focus(), []);
	const selectSearch = useCallback(() => searchInputElRef.current?.select(), []);
	const clearSearch = useCallback(() => {
		if (searchDebounceRef.current !== null) {
			clearTimeout(searchDebounceRef.current);
			searchDebounceRef.current = null;
		}
		setSearchInput("");
		void runSearch("");
	}, [runSearch]);

	// ── Derived: open task + prune stale open id ────────────────────────
	const openTaskRecord = useMemo<Task | null>(
		() => (selectedTaskId === null ? null : (tasks.find((x) => x.id === selectedTaskId) ?? null)),
		[selectedTaskId, tasks],
	);
	useEffect(() => {
		if (selectedTaskId !== null && openTaskRecord === null) setSelectedTaskId(null);
	}, [selectedTaskId, openTaskRecord]);

	// Prune copy-set ids the current list no longer paints.
	// biome-ignore lint/correctness/useExhaustiveDependencies: deps list every input that changes the painted set; the host is read live.
	useEffect(() => {
		if (openTaskRecord !== null) return;
		const host = contentSlotRef.current;
		if (!host) return;
		setTaskSelection((sel) => {
			if (sel.selected.size === 0) return sel;
			return pruneTaskSelection(sel, visibleTaskIdSequence(host));
		});
	}, [openTaskRecord, tasks, selection, searchQuery, activeTag, showCompleted, renderNonce]);

	// ── Object-menu target resolver (delegated listeners) ───────────────
	const resolveMenuTarget = useCallback(
		(entityId: string): DelegatedMenuTarget | null => {
			const task = dataRef.current.tasks.find((x) => x.id === entityId);
			if (task) {
				return {
					entityType: TASK_TYPE,
					label: task.name,
					extraItems: [
						{
							id: "edit",
							label: t("tasks.menu.edit"),
							icon: IconName.Pencil,
							run: () => openEditPopover(task),
						},
					],
					...(repository ? { onRemove: () => onRemoveTask(task) } : {}),
				};
			}
			const project = dataRef.current.projects.find((x) => x.id === entityId);
			if (project) {
				return {
					entityType: PROJECT_TYPE,
					label: project.name,
					...(repository ? { onRemove: () => onRemoveProject(project) } : {}),
				};
			}
			return null;
		},
		[repository, openEditPopover, onRemoveTask, onRemoveProject],
	);
	// The delegated menu binds ONCE per stable slot (it's idempotent + lives for
	// the slot's lifetime); route through a ref so the latest resolver / runtime
	// are read at open time without re-binding.
	const resolveMenuTargetRef = useRef(resolveMenuTarget);
	resolveMenuTargetRef.current = resolveMenuTarget;
	const objectMenuRuntimeRef = useRef(objectMenuRuntime);
	objectMenuRuntimeRef.current = objectMenuRuntime;

	// ── Sidebar resize handle ───────────────────────────────────────────
	const resizeRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		const handle = resizeRef.current;
		if (!handle) return;
		const r = attachResizable({
			handle,
			side: "left",
			defaultWidth: 248,
			min: 200,
			max: 420,
			storageKey: "tasks:sidebar-width",
			onWidth: (px) => document.body.style.setProperty("--tasks-sidebar-width", `${px}px`),
		});
		return () => r.destroy();
	}, []);

	// ── Alert scheduler (9.14.9) — vault only ───────────────────────────
	useEffect(() => {
		if (source !== "vault") return;
		const notify = runtime?.services.ui?.notify;
		if (!notify) return;
		const scheduler = createReminderScheduler({
			startedAt: Date.now(),
			getItems: () => taskReminderSources(dataRef.current.tasks),
			notify: (due) => {
				const kind = taskAlertKind(due.id);
				// `ui.notify` can reject (e.g. the capability isn't granted in this
				// vault) — swallow it so a missing alert never surfaces as an uncaught
				// promise rejection.
				void notify(
					kind === TaskAlertKind.Scheduled
						? {
								title: t("tasks.alert.scheduled.title", { name: due.title }),
								body: t("tasks.alert.scheduled.body"),
								dedupeKey: due.dedupeKey,
							}
						: {
								title: t("tasks.alert.due.title", { name: due.title }),
								body: t("tasks.alert.due.body"),
								dedupeKey: due.dedupeKey,
							},
				).catch(() => {});
			},
		});
		const interval = window.setInterval(() => scheduler.tick(Date.now()), ALERT_TICK_MS);
		return () => {
			window.clearInterval(interval);
			scheduler.dispose();
		};
	}, [source, runtime]);

	// ── Running-app intent push channel ─────────────────────────────────
	useEffect(() => {
		if (!runtime?.on) return;
		const sub = runtime.on("intent", (event) => {
			if (event.type !== "intent") return;
			const { verb, payload } = event.intent;
			if (verb === IntentVerb.Open) handleOpenIntent(payload);
			else if (verb === IntentVerb.Compose) handleComposeIntent(payload);
			else if (verb === IntentVerb.QuickLook) handleQuickLookIntent(payload);
		});
		return () => sub.unsubscribe();
	}, [runtime, handleOpenIntent, handleComposeIntent, handleQuickLookIntent]);

	// ── Entity-title hydration → repaint (assignee chips / group-by) ────
	useEffect(() => {
		let timer: ReturnType<typeof setTimeout> | null = null;
		const unsubscribe = subscribeEntityTitles(() => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = null;
				bumpRender();
			}, 250);
		});
		return () => {
			if (timer) clearTimeout(timer);
			unsubscribe();
		};
	}, [bumpRender]);

	const cycleBuiltinSurface = useCallback(
		(direction: 1 | -1) => {
			const order = [TaskSurface.Inbox, TaskSurface.Today, TaskSurface.Upcoming] as const;
			const sel = selectionRef.current;
			const current = sel.kind === TaskSurface.Project ? TaskSurface.Inbox : sel.kind;
			const idx = order.indexOf(current as (typeof order)[number]);
			const next = order[(idx + direction + order.length) % order.length];
			if (next === undefined) return;
			setSelection({ kind: next });
		},
		[setSelection],
	);

	// ── Keyboard (shortcut registry, never raw e.key) ───────────────────
	useEffect(() => {
		const offs = [
			bindShortcut(ActionId.GoInbox, () => setSelection({ kind: TaskSurface.Inbox })),
			bindShortcut(ActionId.GoToday, () => setSelection({ kind: TaskSurface.Today })),
			bindShortcut(ActionId.GoUpcoming, () => setSelection({ kind: TaskSurface.Upcoming })),
			bindShortcut(ActionId.NextSurface, () => cycleBuiltinSurface(1)),
			bindShortcut(ActionId.PrevSurface, () => cycleBuiltinSurface(-1)),
			bindShortcut(ActionId.ToggleShowCompleted, onToggleShowCompleted),
			bindShortcut(ActionId.CopySelection, (event) => {
				if (selectedTaskIdRef.current !== null) return;
				if (taskSelectionSize(taskSelectionRef.current) === 0) return;
				event.preventDefault();
				copySelectionToClipboard();
			}),
			bindShortcut(ActionId.SelectAll, (event) => {
				if (selectedTaskIdRef.current !== null) return;
				event.preventDefault();
				selectAllVisibleTasks();
			}),
			bindShortcut(ActionId.FocusSearch, (event) => {
				event.preventDefault();
				focusSearch();
				selectSearch();
			}),
			bindShortcut(ActionId.ClearSearch, () => {
				if (searchQueryRef.current.length === 0) return;
				clearSearch();
				focusSearch();
			}),
			bindShortcut(ActionId.CloseInspector, () => {
				if (selectedTaskIdRef.current === null) return;
				const active = document.activeElement;
				if (active instanceof HTMLElement && (active.isContentEditable || active.tagName === "INPUT")) {
					return;
				}
				closeTask();
			}),
			bindShortcut(ActionId.QuickLook, (event) => {
				const target = quickLookTarget();
				if (!target) return;
				event.preventDefault();
				handleQuickLookIntent({ entityId: target.id });
			}),
			bindShortcut(ActionId.Compose, (event) => {
				event.preventDefault();
				handleComposeIntent({});
			}),
		];
		return () => {
			for (const off of offs) off?.();
		};
	}, [
		setSelection,
		onToggleShowCompleted,
		copySelectionToClipboard,
		selectAllVisibleTasks,
		clearSearch,
		closeTask,
		quickLookTarget,
		handleQuickLookIntent,
		handleComposeIntent,
		focusSearch,
		selectSearch,
		cycleBuiltinSurface,
	]);
	const searchQueryRef = useRef(searchQuery);
	searchQueryRef.current = searchQuery;

	// ── Content view-builder (DOM) behind a ref boundary ────────────────
	const now = nowAnchor();
	const rowPropsFor = useCallback(
		(task: Task, atNow: number): TaskRowProps => {
			const showProjectChip =
				searchQueryRef.current.length > 0 || selectionRef.current.kind !== TaskSurface.Project;
			return {
				task,
				now: atNow,
				projectsById: projectsById(),
				showProjectChip,
				onToggleComplete,
				onPickIcon,
				onRenameTask,
				onOpenEdit: openEditPopover,
				onSelectTask,
				selectedTaskId: selectedTaskIdRef.current,
				multiSelected: taskSelectionRef.current.selected.has(task.id),
				objectMenuEnabled,
				subtaskCount: subtaskProgress(dataRef.current.tasks, task.id),
				blocked: isBlocked(task, indexById(dataRef.current.tasks)),
				estimateMinutes: task.estimateMinutes ?? null,
				loggedMinutes: task.loggedMinutes ?? null,
				tags: (task.tags ?? []).map((id) => ({ id, label: tagLabel(id) })),
				onClickTag: setActiveTagFilter,
				assigneeName:
					task.assigneeId !== null
						? (getEntityTitle(task.assigneeId) ?? t("tasks.row.assignee.fallback"))
						: null,
			};
		},
		[
			projectsById,
			onToggleComplete,
			onPickIcon,
			onRenameTask,
			openEditPopover,
			onSelectTask,
			objectMenuEnabled,
			setActiveTagFilter,
			tagLabel,
		],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `now` + the rowPropsFor closure carry the live render inputs; deps list the state the builder branches on.
	const buildContent = useCallback((): HTMLElement => {
		const host = document.createElement("div");
		// `display: contents` so the host generates no box — the surface/timeline
		// child becomes a direct flex child of `.tasks-content`, letting the
		// timeline's `height: 100%` resolve (otherwise its sticky axis + toolbar
		// scroll away inside the outer `.tasks-content` overflow).
		host.style.display = "contents";
		const map = projectsById();
		const visible = activeTag !== null ? tasksWithTag(tasks, activeTag) : tasks;
		if (searchQuery.length > 0) {
			const results =
				searchHits !== null
					? taskSearchFromHits(tasks, searchHits)
					: localTaskMatch(tasks, searchQuery);
			host.replaceChildren(
				renderSearchView({
					tasks: results,
					query: searchQuery,
					rowProps: (task) => rowPropsFor(task, now),
				}),
			);
			return host;
		}
		if (selection.kind === TaskSurface.Board) {
			host.replaceChildren(
				renderBoardView({
					columns: compileBoard(visible, BOARD_STATUS_ORDER),
					labelFor: statusLabelFor,
					renderCard: (task) => renderTaskRow(rowPropsFor(task, now)),
					onMoveToStatus: moveTaskToStatus,
					onAddTask: addTaskFromBoard,
					selectedTaskId,
					onSelectTask,
					onOpenEdit: openEditPopover,
				}),
			);
			return host;
		}
		if (selection.kind === TaskSurface.Timeline) {
			const dated = showCompleted ? visible : visible.filter((x) => x.completedAt === null);
			host.replaceChildren(
				renderTimelineView({
					model: compileGantt(dated, now, tasks),
					now,
					selectedTaskId,
					zoom: timelineZoom,
					onSetZoom: onSetTimelineZoom,
					onSelectTask,
					onOpenEdit: openEditPopover,
				}),
			);
			return host;
		}
		const compiled = compileSurfaceFromSelection(
			visible,
			selection,
			showCompleted,
			now,
			upcomingGrouping,
			(projectId) => map.get(projectId)?.name ?? null,
			sort,
		);
		const project =
			selection.kind === TaskSurface.Project ? (map.get(selection.projectId) ?? null) : null;
		host.replaceChildren(
			renderSurfaceView({
				surface: compiled,
				now,
				project,
				projectsById: map,
				showCompleted,
				onToggleShowCompleted,
				upcomingGrouping,
				onSetUpcomingGrouping,
				sort,
				onSetSort,
				rowProps: (task) => rowPropsFor(task, now),
				...(objectMenuRuntime ? { objectMenuRuntime } : {}),
				onPickProjectIcon,
				...(repository ? { onRemoveProject, onRenameProject, onReorderTasks } : {}),
			}),
		);
		return host;
	}, [
		tasks,
		selection,
		searchQuery,
		searchHits,
		activeTag,
		showCompleted,
		upcomingGrouping,
		sort,
		timelineZoom,
		onSetTimelineZoom,
		selectedTaskId,
		renderNonce,
		rowPropsFor,
		projectsById,
		moveTaskToStatus,
		addTaskFromBoard,
		onSelectTask,
		openEditPopover,
		onToggleShowCompleted,
		onSetUpcomingGrouping,
		onSetSort,
		objectMenuRuntime,
		onPickProjectIcon,
		repository,
		onRemoveProject,
		onRenameProject,
		onReorderTasks,
	]);

	const contentHostRef = useDomHost(buildContent, [buildContent]);

	// Wire the delegated object-menu once per stable content slot. The slot
	// survives `replaceChildren` (and the open↔list route swap remounts the
	// host div, so the effect re-binds when the list host reappears — the
	// binder is idempotent per element).
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-bind keyed on the route swap; runtime + resolver read live through refs.
	useEffect(() => {
		if (!objectMenuEnabled) return;
		const host = contentSlotRef.current;
		if (!host) return;
		bindDelegatedObjectMenu(
			host,
			() => objectMenuRuntimeRef.current,
			(id) => resolveMenuTargetRef.current(id),
		);
	}, [objectMenuEnabled, selectedTaskId]);

	// Highlight + scroll the pending row after the list paints (handles the
	// repo round-trip: the new task arrives a tick later).
	// biome-ignore lint/correctness/useExhaustiveDependencies: fires after the list repaints (tasks / renderNonce); openTaskRecord gates it to the list.
	useEffect(() => {
		const target = pendingHighlightRef.current;
		if (target === null || openTaskRecord !== null) return;
		if (!tasks.some((x) => x.id === target)) return;
		pendingHighlightRef.current = null;
		const host = contentSlotRef.current;
		if (!host) return;
		const raf = requestAnimationFrame(() => highlightTaskRow(host, target));
		return () => cancelAnimationFrame(raf);
	}, [tasks, openTaskRecord, renderNonce]);

	// ── Sidebar (DOM) behind a ref boundary ─────────────────────────────
	// biome-ignore lint/correctness/useExhaustiveDependencies: `now` carried with tasks.
	const buildSidebar = useCallback((): HTMLElement => {
		const host = document.createElement("div");
		const counts = computeCounts(tasks, now);
		host.replaceChildren(
			renderSidebar({
				projects,
				selection,
				counts,
				onSelect: setSelection,
				objectMenuEnabled,
				renamingProjectId,
				...(repository ? { onReorderProjects, onCreateProject, onRenameProject } : {}),
			}),
		);
		return host;
	}, [
		tasks,
		projects,
		selection,
		renamingProjectId,
		setSelection,
		objectMenuEnabled,
		repository,
		onReorderProjects,
		onCreateProject,
		onRenameProject,
	]);
	const sidebarHostRef = useDomHost(buildSidebar, [buildSidebar]);

	useEffect(() => {
		if (!objectMenuEnabled) return;
		const host = sidebarSlotRef.current;
		if (!host) return;
		bindDelegatedObjectMenu(
			host,
			() => objectMenuRuntimeRef.current,
			(id) => resolveMenuTargetRef.current(id),
		);
	}, [objectMenuEnabled]);

	// ── Detail route (DOM chrome + persistent React editor root) ────────
	const detailSlotRef = useRef<HTMLDivElement | null>(null);
	const inspectorHandleRef = useRef<TaskInspectorHandle | null>(null);
	const inspectorHostRef = useRef<HTMLElement | null>(null);
	const inspectorTaskIdRef = useRef<string | null>(null);
	const propertyHandleRef = useRef<TaskDetailPropertiesHandle | null>(null);
	const propertyHostRef = useRef<HTMLElement | null>(null);
	const inspectorLockedRef = useRef<boolean>(false);

	const onBodyFirstEdit = useCallback(
		(taskId: string) => {
			const task = dataRef.current.tasks.find((x) => x.id === taskId);
			if (!shouldClearLegacyNotes(task?.notes, migratedNotesRef.current.has(taskId))) return;
			migratedNotesRef.current.add(taskId);
			patchTask(taskId, (existing) => {
				const { notes: _drop, ...rest } = existing;
				return { ...rest, updatedAt: nowAnchor() };
			});
		},
		[patchTask, nowAnchor],
	);

	const inspectorEditorOpts = useCallback(
		(task: Task): { seedNotes?: string; onFirstEdit?(): void; editable?: boolean } => ({
			...(hasLegacyNotes(task.notes) ? { seedNotes: task.notes } : {}),
			onFirstEdit: () => onBodyFirstEdit(task.id),
			editable: !task.locked,
		}),
		[onBodyFirstEdit],
	);

	// Rebuild the detail chrome whenever the open task changes; reuse the
	// persistent editor root by moving its host into the fresh chrome (no lost
	// selection / IME on a title-only refresh).
	// biome-ignore lint/correctness/useExhaustiveDependencies: full rebuild on open-task or its content change; handlers are stable callbacks / refs.
	useEffect(() => {
		const slot = detailSlotRef.current;
		if (!slot) return;
		const task = openTaskRecord;
		if (!task) {
			slot.replaceChildren();
			return;
		}
		const view = renderTaskDetailView({
			task,
			onToggleComplete,
			onRenameTask,
			subtasks: childrenOf(dataRef.current.tasks, task.id),
			onOpenSubtask: openTask,
			onToggleSubtask: onToggleComplete,
			onAddSubtask: (name) => createSubtask(task, name),
			blockedBy: blockingTasks(task, indexById(dataRef.current.tasks)),
			onOpenDependency: openTask,
			onRemoveDependency: (depId) => removeDependency(task, depId),
			onAddDependency: (anchor) => openAddDependencyMenu(task, anchor),
			recurrence: {
				value: task.recurrence,
				anchor: task.dueAt ?? task.scheduledAt ?? task.createdAt,
				labels: RECURRENCE_EDITOR_LABELS,
				summaryLabels: QUICK_LOOK_RECURRENCE_LABELS,
				onChange: (value) =>
					patchTask(task.id, (existing) => ({
						...existing,
						recurrence: value,
						updatedAt: nowAnchor(),
					})),
			},
			comments: {
				values: task.comments ?? [],
				onAdd: (body) => addTaskComment(task.id, body),
				onRemove: (id) => removeTaskComment(task.id, id),
			},
		});

		// Inline property cells island — persistent root moved into the fresh
		// chrome, re-rendered each rebuild so edited values reflect (mirrors the
		// body editor below). Absent in preview (no properties service).
		if (propertiesSvc) {
			if (propertyHandleRef.current && propertyHostRef.current) {
				view.propertyHost.appendChild(propertyHostRef.current);
				propertyHandleRef.current.update(task);
			} else {
				const target = document.createElement("div");
				view.propertyHost.appendChild(target);
				propertyHandleRef.current = mountTaskDetailProperties(target, task, {
					properties: propertiesSvc,
					entityTitleSource,
					makeHandlers: taskFieldHandlers,
				});
				propertyHostRef.current = target;
			}
		}

		if (inspectorHandleRef.current && inspectorHostRef.current) {
			view.editorHost.appendChild(inspectorHostRef.current);
			if (inspectorTaskIdRef.current !== task.id || inspectorLockedRef.current !== !!task.locked) {
				inspectorHandleRef.current.update(task.id, inspectorEditorOpts(task));
				inspectorTaskIdRef.current = task.id;
				inspectorLockedRef.current = !!task.locked;
			}
		} else {
			const mountTarget = document.createElement("div");
			view.editorHost.appendChild(mountTarget);
			const handle = mountTaskInspectorEditor(mountTarget, task.id, inspectorEditorOpts(task));
			if (handle) {
				inspectorHandleRef.current = handle;
				inspectorHostRef.current = mountTarget;
				inspectorTaskIdRef.current = task.id;
			} else if (hasLegacyNotes(task.notes)) {
				view.editorHost.appendChild(renderLegacyNotesFallback(task.notes));
			}
		}
		slot.replaceChildren(view.root);
	}, [openTaskRecord, now, renderNonce]);

	useEffect(
		() => () => {
			inspectorHandleRef.current?.dispose();
			inspectorHandleRef.current = null;
			propertyHandleRef.current?.dispose();
			propertyHandleRef.current = null;
		},
		[],
	);

	// ── Properties overlay (persistent React island) ────────────────────
	const project =
		openTaskRecord && openTaskRecord.projectId !== null
			? (projectsById().get(openTaskRecord.projectId) ?? null)
			: null;

	// ── Header menu contexts ────────────────────────────────────────────
	const headerProject =
		selection.kind === TaskSurface.Project
			? (projects.find((p) => p.id === selection.projectId) ?? null)
			: null;

	const taskHeaderCtx = useCallback((): ObjectMenuContext => {
		const task = openTaskRecord;
		if (!task || !objectMenuRuntime) return null;
		return taskHeaderMenuContext({
			task,
			runtime: objectMenuRuntime,
			extraItems: buildTaskExportItems({ runtime, entityIds: [task.id], name: task.name }),
			...(repository ? { onRemove: () => onRemoveTask(task) } : {}),
		});
	}, [openTaskRecord, objectMenuRuntime, runtime, repository, onRemoveTask]);

	const projectHeaderCtx = useCallback((): ObjectMenuContext => {
		const live = headerProject;
		if (!live || !objectMenuRuntime) return null;
		return projectHeaderMenuContext({
			project: live,
			runtime: objectMenuRuntime,
			extraItems: buildTaskExportItems({
				runtime,
				entityIds: dataRef.current.tasks
					.filter((task) => task.projectId === live.id)
					.map((task) => task.id),
				name: live.name,
				plural: true,
			}),
			...(repository ? { onRemove: () => onRemoveProject(live) } : {}),
		});
	}, [headerProject, objectMenuRuntime, runtime, repository, onRemoveProject]);

	const headerMenuContext = openTaskRecord ? taskHeaderCtx : headerProject ? projectHeaderCtx : null;
	const headerHasObject = headerMenuContext !== null && objectMenuEnabled;

	const headerTitle = openTaskRecord
		? openTaskRecord.name
		: headerTitleText(selection, headerProject);

	const titleEditable =
		(openTaskRecord !== null && !openTaskRecord.locked) || headerProject !== null;
	const onTitleDblClick = useCallback(
		(event: React.MouseEvent<HTMLElement>) => {
			if (!titleEditable) return;
			event.stopPropagation();
			event.preventDefault();
			const el = event.currentTarget;
			if (openTaskRecord) {
				const task = openTaskRecord;
				beginInlineEdit(el, {
					value: task.name,
					ariaLabel: t("tasks.row.name.editAria"),
					inputClassName: "tasks-header__title-input",
					onCommit: (next) => onRenameTask(task, next),
				});
			} else if (headerProject) {
				const proj = headerProject;
				beginInlineEdit(el, {
					value: proj.name,
					ariaLabel: t("tasks.header.renameProject"),
					inputClassName: "tasks-header__title-input",
					onCommit: (next) => onRenameProject(proj.id, next),
				});
			}
		},
		[titleEditable, openTaskRecord, headerProject, onRenameTask, onRenameProject],
	);

	// Project icon-pick button (header left) — the one DOM-only SDK factory in
	// the header chrome, mounted behind a ref boundary.
	const projectIconHostRef = useDomHost(() => {
		const proj = headerProject;
		if (!proj || openTaskRecord) return null;
		return createIconPickerButton({
			value: proj.icon ?? null,
			ariaLabel: t("tasks.header.iconPicker.open"),
			size: 18,
			onChange: (icon) => onPickProjectIcon(proj.id, icon),
		});
	}, [headerProject?.id, headerProject?.icon, openTaskRecord, onPickProjectIcon]);

	const showProjectIcon = headerProject !== null && openTaskRecord === null;

	return (
		<>
			<header className="app-header">
				<div className="app-header__left" id="tasks-header-left">
					<NavButtons history={navHist} onNavigate={applyNavLoc} />
					{showProjectIcon ? <span ref={projectIconHostRef} /> : null}
					<span className="tasks-header__title-menu">
						<span
							className={
								titleEditable ? "app-header__title tasks-header__title--editable" : "app-header__title"
							}
							title={
								openTaskRecord
									? t("tasks.row.name.editAria")
									: headerProject
										? t("tasks.header.renameProject")
										: undefined
							}
							onDoubleClick={onTitleDblClick}
							onContextMenu={(event) => {
								if (!headerMenuContext) return;
								const ctx = headerMenuContext();
								if (!ctx) return;
								event.preventDefault();
								void openObjectMenu({ x: event.clientX, y: event.clientY }, ctx);
							}}
						>
							{headerTitle}
						</span>
					</span>
					{activeTag !== null ? (
						<span className="tasks-header__filter-pill">
							<span>{t("tasks.filter.tag", { tag: tagLabel(activeTag) })}</span>
							<button
								type="button"
								className="tasks-header__filter-clear"
								aria-label={t("tasks.filter.clear")}
								onClick={clearActiveTag}
							>
								✕
							</button>
						</span>
					) : null}
				</div>
				<div className="app-header__right" id="tasks-header-right">
					{openTaskRecord ? null : (
						<button
							type="button"
							className="tasks-header__action"
							data-bs-tooltip={t("tasks.header.newTask")}
							aria-label={t("tasks.header.newTask")}
							onClick={() => handleComposeIntent({})}
						>
							<IconView name={IconName.Plus} size={18} />
						</button>
					)}
					<PanelToggleButton
						side={PanelSide.Left}
						open={navOpen}
						onClick={toggleNav}
						labels={{ show: t("tasks.header.sidebar.show"), hide: t("tasks.header.sidebar.hide") }}
					/>
					{openTaskRecord && propertiesSvc ? (
						<PanelToggleButton
							side={PanelSide.Right}
							open={propsOpen}
							onClick={toggleProps}
							labels={{
								show: t("tasks.header.inspector.show"),
								hide: t("tasks.header.inspector.hide"),
							}}
						/>
					) : null}
					{openTaskRecord ? (
						<LockButton
							locked={!!openTaskRecord.locked}
							onToggle={() =>
								patchTask(openTaskRecord.id, (x) => ({
									...x,
									locked: !x.locked,
									updatedAt: nowAnchor(),
								}))
							}
							lockLabel={t("tasks.header.lock")}
							unlockLabel={t("tasks.header.unlock")}
						/>
					) : null}
					<ObjectMenuMoreButton
						moreActionsLabel={t("tasks.menu.more")}
						context={headerMenuContext ?? (() => null)}
						disabled={!headerHasObject}
						disabledReason={t("tasks.menu.moreDisabled")}
					/>
				</div>
			</header>

			<main
				className="tasks-main"
				id="tasks-main"
				data-nav-open={String(navOpen)}
				data-detail-open={String(openTaskRecord !== null)}
				data-data-source={source}
			>
				<div id="tasks-sidebar-slot" ref={sidebarSlotRef}>
					<div ref={sidebarHostRef} style={{ display: "contents" }} />
				</div>
				<div
					className="tasks-resize"
					id="tasks-resize"
					role="separator"
					aria-orientation="vertical"
					aria-label={t("tasks.header.sidebar.show")}
					tabIndex={0}
					ref={resizeRef}
				/>
				<div className="tasks-content-col">
					<div id="tasks-searchbar-slot" className="tasks-searchbar-slot">
						<Searchbar
							value={searchInput}
							placeholder={t("tasks.search.placeholder")}
							clearLabel={t("tasks.search.clear")}
							onChange={scheduleSearch}
							onClear={() => {
								clearSearch();
								focusSearch();
							}}
							inputRef={searchInputElRef}
						/>
					</div>
					{openTaskRecord ? (
						// Distinct `key` from the list branch: both are `<div className=
						// "tasks-content">` at the same position, so without it React reuses
						// the same DOM node across the open↔list flip and never removes the
						// imperatively-appended `.tasks-detail` subtree (it doesn't manage it).
						// That orphaned detail node then paints over the list — the screen
						// looks stuck even though state navigated. Keys force unmount+remount.
						<div key="detail" className="tasks-content" ref={detailSlotRef} />
					) : (
						<div key="list" className="tasks-content" id="tasks-content-slot" ref={contentSlotRef}>
							<div ref={contentHostRef} style={{ display: "contents" }} />
						</div>
					)}
				</div>
				{propertiesSvc && openTaskRecord ? (
					<PropertiesProvider
						runtime={{ services: { properties: propertiesSvc } }}
						entityTitleSource={entityTitleSource}
					>
						<TaskPropertiesPanel
							task={openTaskRecord}
							open={propsOpen}
							onClose={toggleProps}
							{...(repository && !openTaskRecord.locked
								? {
										...taskFieldHandlers(openTaskRecord.id),
										onValuesChange: (values: ValuesMap) => onTaskValuesChange(openTaskRecord.id, values),
									}
								: {})}
						/>
					</PropertiesProvider>
				) : null}
			</main>
		</>
	);
}

function notFoundBody(): HTMLElement {
	const p = document.createElement("p");
	p.className = "tasks-quicklook__empty";
	p.textContent = t("tasks.quickLook.notFound");
	return p;
}
