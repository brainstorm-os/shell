/**
 * Renders a single task row. Returns the root `<li>` element so the
 * caller controls the list semantics. Wires up the completion toggle +
 * inline-edit affordances on the priority, date and project chips so the
 * row isn't read-only chrome — every visible property can be changed
 * without leaving the list. Empty fields render dim "Set X" stubs that
 * share the same click targets as the populated chips so one set of
 * handlers covers both cases.
 *
 * Clicking the row body (anywhere that isn't the toggle, an icon button
 * or an editable chip) selects the task → opens the right-side inspector
 * (9.14.6). The name is a focusable button: a single activation selects
 * (so Tab→Enter is the keyboard path to the inspector); a double-click
 * swaps it for an inline rename input.
 *
 * The toggle / name / chip builders are exported so the inspector header
 * reuses the *same* chrome rather than re-implementing it.
 */

import { summarizeRecurrence } from "@brainstorm/sdk-types";
import { createEntityIconElement } from "@brainstorm/sdk/entity-icon";
import { type SelectionModifier, modifierFromEvent } from "@brainstorm/sdk/selection";
import { recurrenceLabels } from "../i18n/recurrence-labels";
import { t } from "../i18n/t";
import { dateKey } from "../logic/date-buckets";
import { isPastDue } from "../logic/task-status";
import { formatMinutes } from "../logic/task-time";
import { TASK_TYPE } from "../storage/entities-repository";
import type { Project } from "../types/project";
import { Priority, type Task } from "../types/task";
import { ENTITY_ID_ATTR, ENTITY_TYPE_ATTR, createMoreButton } from "./delegated-object-menu";
import { formatDateRelative } from "./format-date";
import { beginInlineEdit } from "./inline-edit";

/** Built once — `t()` is a pure manifest lookup. */
const RECURRENCE_LABELS = recurrenceLabels();

const PRIORITY_LABEL: Record<Priority, string> = {
	[Priority.None]: "tasks.priority.none",
	[Priority.Low]: "tasks.priority.low",
	[Priority.Medium]: "tasks.priority.medium",
	[Priority.High]: "tasks.priority.high",
	[Priority.Critical]: "tasks.priority.critical",
};

export type TaskRowProps = {
	task: Task;
	now: number;
	projectsById: ReadonlyMap<string, Project>;
	/** Whether to show the project chip. False on the Project surface
	 *  (the project name is already in the surface header). */
	showProjectChip: boolean;
	onToggleComplete(task: Task): void;
	/** Open the shared icon picker for this task (the app mounts the
	 *  picker + persists — the row stays presentational). */
	onPickIcon(task: Task): void;
	onRenameTask(task: Task, name: string): void;
	onOpenEdit(task: Task): void;
	/** Select the task → open the right-side inspector (9.14.6). Fired by
	 *  a single click / keyboard activation on the row body. A `modifier`
	 *  (Mod / Shift click) routes into the multi-select copy-set instead of
	 *  opening — the list decides which. */
	onSelectTask(task: Task, modifier?: SelectionModifier): void;
	/** The currently-inspected task id, so the row can paint its selected
	 *  state. Null / absent when no inspector is open. */
	selectedTaskId?: string | null;
	/** Whether the row is part of the multi-select copy-set (distinct from the
	 *  single open/inspected task above). Paints `data-multiselected`. */
	multiSelected?: boolean;
	/** Whether the shared object menu is available (a shell runtime is
	 *  present). False in preview mode — the row then renders no ⋯
	 *  affordance and carries no entity hooks. The right-click + ⋯ click
	 *  themselves are handled by ONE delegated listener on the list
	 *  container (see `delegated-object-menu.ts`), not per row. */
	objectMenuEnabled: boolean;
	/** The owning section's date as a `YYYY-MM-DD` key, set only on
	 *  date-grouped surfaces (Today's "Today" section, Upcoming's day
	 *  sections). When the row's own anchor date falls on this same day
	 *  the date chip is suppressed — the section heading already states
	 *  it, so "Due Jun 23" under a "Jun 23" header is pure noise. A date
	 *  that *differs* (scheduled today but due later) keeps the chip so
	 *  the divergence stays visible. */
	sectionDateKey?: string;
	/** Direct-subtask completion for the progress chip (9.14.7). Omitted or
	 *  `total === 0` → no chip (a leaf task shows nothing). */
	subtaskCount?: { done: number; total: number };
	/** Whether the task is blocked by an open dependency (9.14.8) → a "Blocked"
	 *  flag on the row. */
	blocked?: boolean;
	/** Planned + logged effort (9.14.13). When `estimateMinutes` is set, the row
	 *  shows a "logged / estimate" duration chip (over-budget when logged exceeds
	 *  the estimate). */
	estimateMinutes?: number | null;
	loggedMinutes?: number | null;
	/** Tags (9.14.10) shown as small chips; clicking one filters by it. Each is
	 *  the vocabulary item `id` plus its resolved display `label`. */
	tags?: readonly { id: string; label: string }[];
	onClickTag?(tagId: string): void;
	/** Assignee display name (9.14.15) — resolved by the app from
	 *  `task.assigneeId` via the shared entity-title index. Null/absent =
	 *  unassigned (no chip); editing happens in the detail's properties
	 *  panel, so the chip is display-only. */
	assigneeName?: string | null;
};

export function renderTaskRow(props: TaskRowProps): HTMLLIElement {
	const { task, now, projectsById, showProjectChip, onToggleComplete, onPickIcon } = props;
	const done = task.completedAt !== null;
	const overdue = isPastDue(task, now);

	const root = document.createElement("li");
	root.className = "task-row";
	root.dataset.taskId = task.id;
	root.dataset.done = String(done);
	root.dataset.overdue = String(overdue);
	root.dataset.priority = task.priority;
	root.dataset.selected = String(props.selectedTaskId === task.id);
	root.dataset.multiselected = String(props.multiSelected ?? false);
	// Resolution key for the ONE delegated object-menu listener on the
	// list container (mirrors Database's `[data-entity-id]` stage rows).
	// Carried only when a runtime is present so preview rows stay inert.
	// `bs-object-menu__host--row` opts into the SDK's canonical
	// hide-by-default / reveal-on-hover affordance — without it the
	// default `.bs-object-menu__more { opacity: 0.55 }` bleeds through
	// (the same drift the sidebar carried).
	if (props.objectMenuEnabled) {
		root.classList.add("bs-object-menu__host--row");
		root.setAttribute(ENTITY_ID_ATTR, task.id);
		root.setAttribute(ENTITY_TYPE_ATTR, TASK_TYPE);
	}

	root.appendChild(renderCompletionToggle(task, done, onToggleComplete));

	// Body — name + chip strip. A click anywhere on the body that isn't an
	// interactive control selects the task (opens the inspector). The
	// toggle / glyph / chips all `stopPropagation`, so only the name
	// button + empty body area reach this handler.
	const body = document.createElement("div");
	body.className = "task-row__body";
	body.addEventListener("click", (event) => {
		if (event.target instanceof Element && event.target.closest("input")) return;
		props.onSelectTask(
			task,
			modifierFromEvent({ shift: event.shiftKey, mod: event.metaKey || event.ctrlKey }),
		);
	});

	const heading = document.createElement("div");
	heading.className = "task-row__heading";

	// The task's OWN universal icon — click to change via the shared SDK
	// picker (per-object-icons-everywhere). A real <button> for focus +
	// keyboard activation; stop propagation so it doesn't trigger row select.
	// Per [[feedback_no_default_type_icon_fallback]] (project-wide): tasks
	// without an own icon render NO icon button — the heading's flex gap
	// collapses around the missing slot and the name slides left. Iconless
	// tasks pick an icon via the row's context menu / inspector.
	const taskIconEl = createEntityIconElement(task.icon ?? null, { size: 16 });
	if (taskIconEl) {
		const glyph = document.createElement("button");
		glyph.type = "button";
		glyph.className = "task-row__glyph";
		glyph.setAttribute("aria-label", t("tasks.row.icon.aria"));
		glyph.appendChild(taskIconEl);
		glyph.addEventListener("click", (event) => {
			event.stopPropagation();
			onPickIcon(task);
		});
		heading.appendChild(glyph);
	}

	const name = renderEditableName(task, props.onRenameTask);
	heading.appendChild(name);
	body.appendChild(heading);

	const chips = document.createElement("div");
	chips.className = "task-row__chips";

	const pri = priorityChip(task);
	if (pri) chips.appendChild(pri);

	if (!dateChipRedundant(task, props.sectionDateKey)) {
		const date = dateChip(task, now, overdue);
		if (date) chips.appendChild(date);
	}

	if (task.recurrence !== null) {
		const summary = summarizeRecurrence(task.recurrence, RECURRENCE_LABELS);
		chips.appendChild(
			chip({
				kind: "recurring",
				label: "↻",
				ariaLabel: summary,
				title: summary,
			}),
		);
	}

	if (showProjectChip) {
		const proj = projectChip(task, projectsById);
		if (proj) chips.appendChild(proj);
	}

	if (props.assigneeName) {
		const who = document.createElement("span");
		who.className = "task-row__assignee";
		who.textContent = props.assigneeName;
		who.title = t("tasks.row.assignee.title", { name: props.assigneeName });
		chips.appendChild(who);
	}

	if (props.subtaskCount && props.subtaskCount.total > 0) {
		const badge = document.createElement("span");
		badge.className = "task-row__subtasks";
		const label = t("tasks.subtasks.progress", {
			done: props.subtaskCount.done,
			total: props.subtaskCount.total,
		});
		badge.textContent = `☑ ${label}`;
		badge.title = t("tasks.subtasks.heading");
		if (props.subtaskCount.done === props.subtaskCount.total) badge.dataset.complete = "true";
		chips.appendChild(badge);
	}

	if (props.blocked) {
		const flag = document.createElement("span");
		flag.className = "task-row__blocked";
		flag.textContent = t("tasks.dependencies.blocked");
		chips.appendChild(flag);
	}

	if (props.tags && props.tags.length > 0) {
		for (const tag of props.tags) {
			const chip = document.createElement("button");
			chip.type = "button";
			chip.className = "task-row__tag";
			chip.textContent = tag.label;
			if (props.onClickTag) {
				const onClickTag = props.onClickTag;
				chip.addEventListener("click", (e) => {
					e.stopPropagation();
					onClickTag(tag.id);
				});
			} else {
				chip.disabled = true;
			}
			chips.appendChild(chip);
		}
	}

	if (typeof props.estimateMinutes === "number" && props.estimateMinutes > 0) {
		const logged = typeof props.loggedMinutes === "number" ? props.loggedMinutes : 0;
		const chip = document.createElement("span");
		chip.className = "task-row__time";
		chip.textContent =
			logged > 0
				? `${formatMinutes(logged)} / ${formatMinutes(props.estimateMinutes)}`
				: formatMinutes(props.estimateMinutes);
		if (logged > props.estimateMinutes) chip.dataset.over = "true";
		chips.appendChild(chip);
	}

	body.appendChild(chips);
	root.appendChild(body);

	// Visible ⋯ overflow affordance — INERT markup only (no per-row
	// listeners). Right-click anywhere on the row and clicking this button
	// are both handled by ONE delegated listener on the list container,
	// which resolves the target via `data-entity-id`. Skipped in preview
	// mode (no runtime to act through).
	if (props.objectMenuEnabled) {
		const more = createMoreButton();
		more.classList.add("task-row__more");
		root.appendChild(more);
	}

	return root;
}

/** Completion toggle — a real `<button>` so it gets focus + keyboard
 *  activation for free. Exported so the inspector header reuses it. */
export function renderCompletionToggle(
	task: Task,
	done: boolean,
	onToggleComplete: (task: Task) => void,
): HTMLButtonElement {
	const toggle = document.createElement("button");
	toggle.type = "button";
	toggle.className = "task-row__toggle";
	toggle.setAttribute("aria-label", t("tasks.row.toggle.aria"));
	toggle.setAttribute("aria-pressed", String(done));
	toggle.addEventListener("click", (event) => {
		event.stopPropagation();
		onToggleComplete(task);
	});

	const tick = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	tick.setAttribute("viewBox", "0 0 16 16");
	tick.setAttribute("aria-hidden", "true");
	tick.classList.add("task-row__tick");
	const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
	path.setAttribute("d", "M3.5 8.5 L7 12 L13 5");
	path.setAttribute("fill", "none");
	path.setAttribute("stroke", "currentColor");
	path.setAttribute("stroke-width", "2");
	path.setAttribute("stroke-linecap", "round");
	path.setAttribute("stroke-linejoin", "round");
	tick.appendChild(path);
	toggle.appendChild(tick);
	return toggle;
}

/** Click-to-select name. A `<span>`-styled `<button>` whose single
 *  activation selects the row (opens the inspector — the click bubbles
 *  to the body handler); a double-click swaps it for an inline rename
 *  `<input>` with Enter to commit / Escape to cancel / blur to commit.
 *  Exported so the inspector header reuses the identical inline-rename
 *  affordance for the task title. */
export function renderEditableName(
	task: Task,
	onRename: (task: Task, name: string) => void,
	opts: { singleClick?: boolean } = {},
): HTMLElement {
	const host = document.createElement("div");
	host.className = "task-row__name";

	const label = document.createElement("button");
	label.type = "button";
	label.className = "task-row__name-label";
	label.setAttribute("aria-label", t("tasks.row.name.editAria"));
	label.textContent = task.name;
	host.appendChild(label);

	function enterEditMode(): void {
		beginInlineEdit(label, {
			value: task.name,
			ariaLabel: t("tasks.row.name.editAria"),
			inputClassName: "task-row__name-input",
			onCommit: (next) => onRename(task, next),
		});
	}

	// In the detail view (`singleClick`) the title is the page subject, so a
	// single click edits. In the list a single click opens the task, so editing
	// stays on double-click there.
	host.addEventListener("dblclick", (event) => {
		event.stopPropagation();
		event.preventDefault();
		enterEditMode();
	});
	if (opts.singleClick) {
		label.addEventListener("click", (event) => {
			event.stopPropagation();
			event.preventDefault();
			enterEditMode();
		});
	}
	return host;
}

// The chips below are glance-only: they display a task's priority / date /
// project at rest. Editing happens by opening the task (its detail mounts the
// shared property cells). An unset field shows no chip.
export function priorityChip(task: Task): HTMLSpanElement | null {
	if (task.priority === Priority.None) return null;
	const el = document.createElement("span");
	el.className = "task-row__chip";
	el.dataset.kind = "priority";
	el.dataset.value = task.priority;
	el.textContent = t(PRIORITY_LABEL[task.priority]);
	return el;
}

/** True when the row sits in a date-grouped section whose heading
 *  already states this task's anchor date — so repeating it on the row
 *  is noise. Only an empty date (nothing to repeat) or a date that
 *  diverges from the section's day keeps the chip. */
function dateChipRedundant(task: Task, sectionDateKey: string | undefined): boolean {
	if (sectionDateKey === undefined) return false;
	const anchor = task.dueAt ?? task.scheduledAt;
	if (anchor === null) return false;
	return dateKey(anchor) === sectionDateKey;
}

export function dateChip(task: Task, now: number, overdue: boolean): HTMLSpanElement | null {
	const dateAnchor = task.dueAt ?? task.scheduledAt ?? null;
	if (dateAnchor === null) return null;
	const el = document.createElement("span");
	el.className = "task-row__chip";
	el.dataset.kind = overdue ? "date-overdue" : "date";
	const labelKey = task.dueAt !== null ? "tasks.row.due" : "tasks.row.scheduled";
	el.textContent = t(labelKey, { date: formatDateRelative(dateAnchor, now) });
	return el;
}

export function projectChip(
	task: Task,
	projectsById: ReadonlyMap<string, Project>,
): HTMLSpanElement | null {
	if (task.projectId === null) return null;
	const project = projectsById.get(task.projectId);
	if (!project) return null;
	const el = document.createElement("span");
	el.className = "task-row__chip";
	el.dataset.kind = "project";
	if (project.colorHint) el.style.setProperty("--chip-color", project.colorHint);
	// Project names are unbounded user/seed text — keep the label in its own
	// span so CSS can ellipsize it without collapsing the leading color dot,
	// and expose the full name via `title`.
	const text = document.createElement("span");
	text.className = "task-row__chip-text";
	text.textContent = project.name;
	el.title = project.name;
	el.appendChild(text);
	return el;
}

type ChipSpec = {
	kind: "priority" | "date" | "date-overdue" | "recurring" | "project";
	label: string;
	dataAttr?: string;
	colorHint?: string | null;
	ariaLabel?: string;
	title?: string;
};

function chip(spec: ChipSpec): HTMLSpanElement {
	const el = document.createElement("span");
	el.className = "task-row__chip";
	el.dataset.kind = spec.kind;
	if (spec.dataAttr) el.dataset.value = spec.dataAttr;
	if (spec.colorHint) el.style.setProperty("--chip-color", spec.colorHint);
	if (spec.ariaLabel) el.setAttribute("aria-label", spec.ariaLabel);
	if (spec.title) el.title = spec.title;
	el.textContent = spec.label;
	return el;
}
