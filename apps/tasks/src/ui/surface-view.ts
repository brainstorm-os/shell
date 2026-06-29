/**
 * Surface view — renders one `CompiledSurface` into the main content
 * pane. Section headers + task rows + empty state.
 *
 * For a project surface, the body h1 row mirrors the app-header's
 * identity surface (icon-pick + title + object-menu) — the consistency
 * the user asked for: a project's icon and title behave the same way in
 * both places, both edits flow through the same patch path and both
 * re-render together on the next `render()`.
 */

import type { Icon } from "@brainstorm/sdk-types";
import { Orientation, attachCompositeKeyboard } from "@brainstorm/sdk/a11y";
import { createEmptyState } from "@brainstorm/sdk/empty-state";
import { IconName, createIconElement } from "@brainstorm/sdk/icon";
import {
	type ObjectMenuContext,
	type ObjectMenuRuntime,
	openAnchoredMenu,
	openObjectMenu,
} from "@brainstorm/sdk/object-menu";
import { createIconPickerButton } from "@brainstorm/sdk/picker-host";
import { t, tCount } from "../i18n/t";
import type { CompiledSection, CompiledSurface } from "../logic/compile-surface";
import { dateKey } from "../logic/date-buckets";
import { TASK_SORTS, TaskSort } from "../logic/task-sort";
import type { Project } from "../types/project";
import { TaskSurface, UPCOMING_GROUPINGS, UpcomingGrouping } from "../types/surface";
import type { Task } from "../types/task";
import { formatGroupDateLabel } from "./format-date";
import { projectHeaderMenuContext } from "./header-object-menu";
import { beginInlineEdit } from "./inline-edit";
import { wireListDnd } from "./list-dnd";
import { type TaskRowProps, renderTaskRow } from "./task-row";

export type SurfaceViewProps = {
	surface: CompiledSurface;
	now: number;
	/** Project record when `surface.surface === Project`. */
	project: Project | null;
	/** Live project lookup — the header's ⋯ menu re-reads the record at
	 *  menu-open time so it never acts on a stale row. Rows don't use this
	 *  (their copy rides `rowProps`). */
	projectsById: ReadonlyMap<string, Project>;
	showCompleted: boolean;
	onToggleShowCompleted(): void;
	/** Build the full `TaskRowProps` for one row — the app's single
	 *  `rowPropsFor` builder, so a surface row, a search row, a board card
	 *  and an in-place-patched row are all byte-identical (one source of
	 *  truth for chips/handlers; the per-section `sectionDateKey` is the
	 *  only field layered on top here). */
	rowProps(task: Task): TaskRowProps;
	/** Mirrors the app-header path so the body h1's icon + ⋯ menu act on
	 *  the same project record. Optional — preview mode (no runtime)
	 *  omits them and the icon/menu fall back to display-only chrome. */
	objectMenuRuntime?: ObjectMenuRuntime;
	onPickProjectIcon?(projectId: string, icon: Icon | null): void;
	/** Commit a new name for the body-title inline rename (double-click).
	 *  Optional — preview mode (no runtime) omits it and the title is
	 *  display-only. */
	onRenameProject?(projectId: string, name: string): void;
	onRemoveProject?(project: Project): void;
	/** Called when the user drops a task in a new position within the
	 *  current flat-list surface (Inbox or Project). `orderedIds` is the
	 *  full new top-to-bottom ordering of that surface's open tasks. The
	 *  app renumbers `sortIndex` to `0..n-1` and persists. */
	onReorderTasks?(orderedIds: string[]): void;
	/** Upcoming's active grouping axis (F-164). Only consulted when
	 *  `surface.surface === Upcoming`; the header shows the "Group by ▾"
	 *  picker when `onSetUpcomingGrouping` is wired (preview mode omits it). */
	upcomingGrouping?: UpcomingGrouping;
	onSetUpcomingGrouping?(grouping: UpcomingGrouping): void;
	/** The active within-surface sort. The header shows the "Sort ▾" picker
	 *  on every list surface when `onSetSort` is wired (preview mode omits
	 *  it). Defaults to `TaskSort.Default` (the surface's native order). */
	sort?: TaskSort;
	onSetSort?(sort: TaskSort): void;
};

export type SearchViewProps = {
	tasks: readonly Task[];
	/** The raw user query — shown in the heading + empty state. */
	query: string;
	/** Same single row builder as `SurfaceViewProps.rowProps`. */
	rowProps(task: Task): TaskRowProps;
};

/**
 * The inline-search results pane (9.22.3). A flat, rank-ordered list —
 * no sectioning, no surface chrome — so the result order *is* the
 * relevance order the index returned. Reuses `renderTaskList` /
 * `renderTaskRow` so a search row is visually identical to a surface row.
 */
export function renderSearchView(props: SearchViewProps): HTMLElement {
	const root = document.createElement("section");
	root.className = "tasks-surface";
	root.dataset.surface = "search";

	const header = document.createElement("header");
	header.className = "tasks-surface__header";
	const title = document.createElement("h1");
	title.className = "tasks-surface__title";
	title.textContent = t("tasks.search.title");
	header.appendChild(title);
	const meta = document.createElement("div");
	meta.className = "tasks-surface__meta";
	const count = document.createElement("span");
	count.className = "tasks-surface__count";
	count.textContent = tCount("tasks.header.count", props.tasks.length);
	meta.appendChild(count);
	header.appendChild(meta);
	root.appendChild(header);

	if (props.tasks.length === 0) {
		const empty = document.createElement("section");
		empty.className = "tasks-empty";
		const h = document.createElement("h2");
		h.textContent = t("tasks.search.empty.title");
		empty.appendChild(h);
		const p = document.createElement("p");
		p.textContent = t("tasks.search.empty.body", { query: props.query });
		empty.appendChild(p);
		root.appendChild(empty);
		return root;
	}

	const block = document.createElement("section");
	block.className = "tasks-section";
	block.dataset.sectionKey = "search";
	block.appendChild(renderTaskList(props.tasks, { rowProps: props.rowProps }));
	root.appendChild(block);
	return root;
}

export function renderSurfaceView(props: SurfaceViewProps): HTMLElement {
	const root = document.createElement("section");
	root.className = "tasks-surface";
	root.dataset.surface = props.surface.surface;

	root.appendChild(renderHeader(props));

	if (props.surface.count === 0) {
		root.appendChild(renderEmptyState(props.surface.surface));
		return root;
	}

	for (const section of props.surface.sections) {
		root.appendChild(renderSection(section, props));
	}
	return root;
}

function renderHeader(props: SurfaceViewProps): HTMLElement {
	const header = document.createElement("header");
	header.className = "tasks-surface__header";

	// Title row mirrors Notes' header pattern — icon + title + ⋯ menu sit
	// on ONE inline-flex baseline, never stacked. `<h1>` is a block
	// element; force `display: inline-flex` on the row so it doesn't
	// break out of its flex parent (`.tasks-surface__header`).
	const titleRow = document.createElement("div");
	titleRow.className = "tasks-surface__title-row";

	const project = props.surface.surface === TaskSurface.Project ? props.project : null;

	if (project && props.onPickProjectIcon) {
		const projectId = project.id;
		titleRow.appendChild(
			createIconPickerButton({
				value: project.icon ?? null,
				ariaLabel: t("tasks.header.iconPicker.open"),
				size: 22,
				onChange: (icon) => props.onPickProjectIcon?.(projectId, icon),
			}),
		);
	}

	const title = document.createElement("h1");
	title.className = "tasks-surface__title";
	title.textContent = surfaceTitle(props);
	titleRow.appendChild(title);

	// A project title is directly editable (double-click) and exposes its
	// object menu via right-click — the ⋯ button next to the title is gone;
	// the canonical ⋯ lives in the app-header right group.
	if (project && props.objectMenuRuntime) {
		const runtime = props.objectMenuRuntime;
		const projectId = project.id;
		const onRemove = props.onRemoveProject;
		const projectsById = props.projectsById;
		const menuContext = (): ObjectMenuContext => {
			const live = projectsById.get(projectId);
			if (!live) return null;
			return projectHeaderMenuContext({
				project: live,
				runtime,
				...(onRemove ? { onRemove: () => onRemove(live) } : {}),
			});
		};
		titleRow.addEventListener("contextmenu", (event) => {
			const ctx = menuContext();
			if (!ctx) return;
			event.preventDefault();
			void openObjectMenu({ x: event.clientX, y: event.clientY }, ctx);
		});
	}

	if (project && props.onRenameProject) {
		const projectId = project.id;
		const onRename = props.onRenameProject;
		title.classList.add("tasks-surface__title--editable");
		title.title = t("tasks.header.renameProject");
		title.addEventListener("dblclick", (event) => {
			event.preventDefault();
			beginInlineEdit(title, {
				value: title.textContent ?? "",
				ariaLabel: t("tasks.header.renameProject"),
				inputClassName: "tasks-surface__title-input",
				onCommit: (next) => onRename(projectId, next),
			});
		});
	}

	header.appendChild(titleRow);

	const meta = document.createElement("div");
	meta.className = "tasks-surface__meta";

	const count = document.createElement("span");
	count.className = "tasks-surface__count";
	count.textContent = tCount("tasks.header.count", props.surface.count);
	meta.appendChild(count);

	const toggle = document.createElement("button");
	toggle.type = "button";
	toggle.className = "tasks-surface__toggle";
	toggle.setAttribute("aria-pressed", String(props.showCompleted));
	toggle.textContent = t("tasks.header.showCompleted");
	toggle.addEventListener("click", () => props.onToggleShowCompleted());
	meta.appendChild(toggle);

	if (props.onSetSort) {
		meta.appendChild(renderSortPicker(props.sort ?? TaskSort.Default, props.onSetSort));
	}

	if (props.surface.surface === TaskSurface.Upcoming && props.onSetUpcomingGrouping) {
		meta.appendChild(
			renderGroupByPicker(
				props.upcomingGrouping ?? UpcomingGrouping.Date,
				props.onSetUpcomingGrouping,
			),
		);
	}

	header.appendChild(meta);
	return header;
}

/** Trailing glyph marking the active choice in a header picker menu. A bare
 *  symbol (language-neutral) shown in the menu's trailing-caption slot — the
 *  leading icon slot carries each row's own axis/sort glyph. */
const SELECTED_MARK = "✓";

/** i18n key for each grouping axis's display label. */
const GROUP_LABEL_KEY: Record<UpcomingGrouping, string> = {
	[UpcomingGrouping.Date]: "tasks.group.date",
	[UpcomingGrouping.Assignee]: "tasks.group.assignee",
	[UpcomingGrouping.Priority]: "tasks.group.priority",
	[UpcomingGrouping.Project]: "tasks.group.project",
	[UpcomingGrouping.Status]: "tasks.group.status",
	[UpcomingGrouping.Tags]: "tasks.group.tags",
};

/** The glyph for each grouping axis — reuses the same property-kind icons
 *  the property panel uses (a grouping axis IS a task property), so "Group
 *  by Date" carries the calendar glyph, "Assignee" the entity glyph, etc.
 *  No new icons are minted; every name is an existing SDK `IconName`. */
const GROUP_AXIS_ICON: Record<UpcomingGrouping, IconName> = {
	[UpcomingGrouping.Date]: IconName.KindDate,
	[UpcomingGrouping.Assignee]: IconName.Entity,
	[UpcomingGrouping.Priority]: IconName.KindSelect,
	[UpcomingGrouping.Project]: IconName.Folder,
	[UpcomingGrouping.Status]: IconName.CheckCircle,
	[UpcomingGrouping.Tags]: IconName.Tag,
};

/** The "Group by ▾" header control — a button that opens the shared anchored
 *  menu listing every grouping axis, the active one checked. Replaces the old
 *  hardcoded Date↔Assignee toggle: every axis is a one-click choice. */
function renderGroupByPicker(
	active: UpcomingGrouping,
	onSet: (grouping: UpcomingGrouping) => void,
): HTMLElement {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "tasks-surface__toggle tasks-surface__toggle--icon";
	button.appendChild(createIconElement(GROUP_AXIS_ICON[active], { size: 14 }));
	const label = document.createElement("span");
	label.textContent = t("tasks.header.groupBy", { axis: t(GROUP_LABEL_KEY[active]) });
	button.appendChild(label);
	button.addEventListener("click", () => {
		const rect = button.getBoundingClientRect();
		openAnchoredMenu(
			{ x: rect.left, y: rect.bottom + 4 },
			UPCOMING_GROUPINGS.map((grouping) => ({
				label: t(GROUP_LABEL_KEY[grouping]),
				icon: GROUP_AXIS_ICON[grouping],
				...(grouping === active ? { shortcut: SELECTED_MARK } : {}),
				onSelect: () => onSet(grouping),
			})),
			{ menuLabel: t("tasks.group.menuLabel"), anchor: button },
		);
	});
	return button;
}

/** i18n key for each sort key's display label. */
const SORT_LABEL_KEY: Record<TaskSort, string> = {
	[TaskSort.Default]: "tasks.sort.default",
	[TaskSort.Priority]: "tasks.sort.priority",
	[TaskSort.DueDate]: "tasks.sort.due",
	[TaskSort.Name]: "tasks.sort.name",
	[TaskSort.Created]: "tasks.sort.created",
};

/** The glyph for each sort key — like the grouping axes, reuses the existing
 *  property-kind / chrome icons rather than minting new ones. */
const SORT_ICON: Record<TaskSort, IconName> = {
	[TaskSort.Default]: IconName.View,
	[TaskSort.Priority]: IconName.KindSelect,
	[TaskSort.DueDate]: IconName.KindDate,
	[TaskSort.Name]: IconName.KindText,
	[TaskSort.Created]: IconName.History,
};

/** The "Sort ▾" header control — present on every list surface. Mirrors the
 *  group-by picker: a leading glyph + label trigger opening the shared
 *  anchored menu, each sort key one click, the active one marked. */
function renderSortPicker(active: TaskSort, onSet: (sort: TaskSort) => void): HTMLElement {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "tasks-surface__toggle tasks-surface__toggle--icon";
	button.appendChild(createIconElement(SORT_ICON[active], { size: 14 }));
	const label = document.createElement("span");
	label.textContent = t("tasks.header.sortBy", { key: t(SORT_LABEL_KEY[active]) });
	button.appendChild(label);
	button.addEventListener("click", () => {
		const rect = button.getBoundingClientRect();
		openAnchoredMenu(
			{ x: rect.left, y: rect.bottom + 4 },
			TASK_SORTS.map((sort) => ({
				label: t(SORT_LABEL_KEY[sort]),
				icon: SORT_ICON[sort],
				...(sort === active ? { shortcut: SELECTED_MARK } : {}),
				onSelect: () => onSet(sort),
			})),
			{ menuLabel: t("tasks.sort.menuLabel"), anchor: button },
		);
	});
	return button;
}

function surfaceTitle(props: SurfaceViewProps): string {
	switch (props.surface.surface) {
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
			return props.project?.name ?? t("tasks.surface.project");
	}
}

function renderSection(section: CompiledSection, props: SurfaceViewProps): HTMLElement {
	const block = document.createElement("section");
	block.className = "tasks-section";
	block.dataset.sectionKey = section.key;

	if (showSectionHeading(section, props.surface)) {
		const h = document.createElement("h2");
		h.className = "tasks-section__heading";
		h.textContent = sectionHeading(section, props.now);
		block.appendChild(h);
	}

	const dndEnabled =
		(props.surface.surface === TaskSurface.Inbox || props.surface.surface === TaskSurface.Project) &&
		typeof props.onReorderTasks === "function";

	const sectionDateKey = sectionDateGroupKey(section, props.surface.surface, props.now);

	block.appendChild(
		renderTaskList(section.tasks, {
			rowProps: props.rowProps,
			dndEnabled,
			...(sectionDateKey ? { sectionDateKey } : {}),
			...(props.onReorderTasks ? { onReorderTasks: props.onReorderTasks } : {}),
		}),
	);
	return block;
}

/** The `YYYY-MM-DD` a date-grouped section's heading represents, so its
 *  rows can suppress the redundant per-row date chip. Upcoming sections
 *  carry the day in their `upcoming.<key>` id; Today's "today" section
 *  represents the current day. Every other surface/section returns
 *  undefined — their rows keep the date chip. */
function sectionDateGroupKey(
	section: CompiledSection,
	surface: TaskSurface,
	now: number,
): string | undefined {
	if (surface === TaskSurface.Upcoming && section.key.startsWith("upcoming.")) {
		const rest = section.key.slice("upcoming.".length);
		// Only date-keyed sections (`upcoming.<YYYY-MM-DD>`) suppress the
		// chip — assignee-grouped sections (F-164) keep per-row dates; the
		// chronology is exactly what the per-person reading needs.
		if (/^\d{4}-\d{2}-\d{2}$/.test(rest)) return rest;
		return undefined;
	}
	if (surface === TaskSurface.Today && section.key === "today.today") {
		return dateKey(now);
	}
	return undefined;
}

type TaskListOpts = {
	rowProps(task: Task): TaskRowProps;
	/** When true, rows in this list are HTML5-draggable and a `wireListDnd`
	 *  is bound. Off in date-grouped surfaces (Today / Upcoming) + the
	 *  search results — only Inbox / Project flat lists opt in. */
	dndEnabled?: boolean;
	onReorderTasks?(orderedIds: string[]): void;
	/** Layered onto each row's props to suppress a date chip that merely
	 *  repeats the section heading's date. Set only on date-grouped
	 *  sections. */
	sectionDateKey?: string;
};

/** The `<ul>` of task rows — shared by surface sections and the search
 *  results pane so a row looks identical wherever it appears. */
function renderTaskList(tasks: readonly Task[], opts: TaskListOpts): HTMLElement {
	const list = document.createElement("ul");
	list.className = "tasks-section__list";
	if (opts.dndEnabled) list.classList.add("tasks-section__list--draggable");
	// One props build per row — reused by the row render AND the keyboard
	// binding below so the two can't disagree on handlers/selection.
	const rowPropsList = tasks.map((task) => opts.rowProps(task));
	rowPropsList.forEach((rowProps, index) => {
		const task = rowProps.task;
		const row = renderTaskRow({
			...rowProps,
			...(opts.sectionDateKey ? { sectionDateKey: opts.sectionDateKey } : {}),
		});
		row.dataset.compositeIndex = String(index);
		// Drag-and-drop is opt-in per surface — only open tasks in
		// Inbox/Project participate. Done tasks stay anchored at the
		// bottom by completion time so they can't be hand-shuffled.
		if (opts.dndEnabled && task.completedAt === null) {
			row.draggable = true;
			row.setAttribute("aria-grabbed", "false");
		}
		list.appendChild(row);
	});
	if (opts.dndEnabled && opts.onReorderTasks) {
		const onReorder = opts.onReorderTasks;
		wireListDnd({
			list,
			idAttr: "taskId",
			classPrefix: "task-row",
			onReorder,
		});
	}

	// KBN-A-tasks: arrow-key roving across the task rows via the shared DOM
	// composite-keyboard binding. The cursor follows the inspected task
	// (`selectedTaskId`); moving it selects (same as a row click → opens the
	// inspector), Enter opens the task for editing (same as the row's open
	// action). The list is rebuilt on every render, so the cursor is derived
	// from props each time — the binding only stamps roles + roving tabindex.
	const first = rowPropsList[0];
	if (first) {
		let cursor = Math.max(
			0,
			tasks.findIndex((task) => task.id === first.selectedTaskId),
		);
		attachCompositeKeyboard(list, {
			orientation: Orientation.Vertical,
			count: () => tasks.length,
			activeIndex: () => cursor,
			onActiveIndexChange: (i) => {
				cursor = i;
				const rowProps = rowPropsList[i];
				if (rowProps) rowProps.onSelectTask(rowProps.task);
			},
			onActivate: (i) => {
				const rowProps = rowPropsList[i];
				if (rowProps) rowProps.onOpenEdit(rowProps.task);
			},
		});
	}
	return list;
}

/** Inbox + Project surfaces have a single section whose heading is
 *  redundant with the surface title; suppress it. Today + Upcoming need
 *  per-section headings (Overdue / Today / dates). */
function showSectionHeading(section: CompiledSection, surface: CompiledSurface): boolean {
	if (surface.surface === TaskSurface.Inbox) return false;
	if (surface.surface === TaskSurface.Project) return false;
	return true;
}

function sectionHeading(section: CompiledSection, now: number): string {
	// Axis groupings carry an already-localized literal heading.
	if (section.title !== undefined) return section.title;
	if (section.titleKey === "tasks.section.date") {
		const raw = section.titleParams?.date;
		if (typeof raw === "string") {
			// raw is `YYYY-MM-DD` from the compiler — re-parse to a local
			// midnight and humanise.
			const [y, m, d] = raw.split("-").map(Number);
			if (y && m && d) {
				const epoch = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
				return formatGroupDateLabel(epoch, now);
			}
		}
	}
	return t(section.titleKey, section.titleParams ?? {});
}

type EmptySpec = { icon: IconName; titleKey: string; bodyKey: string };
// Inbox / Today / Upcoming have their own copy; every other surface (Project,
// Board, Timeline) falls back to the Project empty, as the prior ternary did.
const SURFACE_EMPTY: Partial<Record<TaskSurface, EmptySpec>> = {
	[TaskSurface.Inbox]: {
		icon: IconName.Inbox,
		titleKey: "tasks.empty.inbox.title",
		bodyKey: "tasks.empty.inbox.body",
	},
	[TaskSurface.Today]: {
		icon: IconName.Sun,
		titleKey: "tasks.empty.today.title",
		bodyKey: "tasks.empty.today.body",
	},
	[TaskSurface.Upcoming]: {
		icon: IconName.KindDate,
		titleKey: "tasks.empty.upcoming.title",
		bodyKey: "tasks.empty.upcoming.body",
	},
	[TaskSurface.Project]: {
		icon: IconName.CheckCircle,
		titleKey: "tasks.empty.project.title",
		bodyKey: "tasks.empty.project.body",
	},
};

function renderEmptyState(surface: TaskSurface): HTMLElement {
	// Shared `<EmptyState>` Hero via the DOM twin (`createEmptyState`) so the
	// empty surface matches the rest of the fleet (F-301).
	const spec = SURFACE_EMPTY[surface] ?? SURFACE_EMPTY[TaskSurface.Project];
	if (!spec) throw new Error("missing Project empty spec");
	return createEmptyState({ icon: spec.icon, title: t(spec.titleKey), hint: t(spec.bodyKey) });
}
