/**
 * Sidebar — the left navigation pane per [[app-panel-sides]] (nav left,
 * inspector right). Holds the four built-in surfaces and the projects
 * list (reorderable by drag-and-drop).
 *
 * Drag-and-drop wires the project list to `onReorderProjects` —
 * the app does the renumbering + persistence; the sidebar only signals
 * the dropped-on index. Native HTML5 DnD (no library); the entire row
 * is the drag source (no separate handle) so the affordance feels like
 * Finder / Things and works on a single pointer.
 */

import { Orientation, SelectionAttribute, attachCompositeKeyboard } from "@brainstorm/sdk/a11y";
import { createEntityIconElement } from "@brainstorm/sdk/entity-icon";
import { IconName } from "@brainstorm/sdk/icon";
import { t } from "../i18n/t";
import { PROJECT_TYPE } from "../storage/entities-repository";
import type { Project } from "../types/project";
import { TaskSurface } from "../types/surface";
import { ENTITY_ID_ATTR, ENTITY_TYPE_ATTR, createMoreButton } from "./delegated-object-menu";
import { TasksIcon, createSharedIcon, createTasksIcon } from "./icons";
import { applyReorder, wireListDnd } from "./list-dnd";

export type SidebarSelection =
	| {
			kind:
				| TaskSurface.Inbox
				| TaskSurface.Today
				| TaskSurface.Upcoming
				| TaskSurface.Board
				| TaskSurface.Timeline;
	  }
	| { kind: TaskSurface.Project; projectId: string };

export type SidebarProps = {
	projects: readonly Project[];
	selection: SidebarSelection;
	/** Map of `${TaskSurface}` or `project.${id}` → open-task count, for
	 *  the right-side badges. */
	counts: ReadonlyMap<string, number>;
	onSelect(selection: SidebarSelection): void;
	/** Called when the user drops a project in a new position. `orderedIds`
	 *  is the full new ordering of the active list (top → bottom). The app
	 *  renumbers `sortIndex` to `0..n-1` and persists. */
	onReorderProjects?(orderedIds: string[]): void;
	/** Create a new project (F-035). Present → a "+" affordance sits by the
	 *  Projects heading; the app mints the `Project/v1`, selects it, and sets
	 *  `renamingProjectId` so its row opens for inline naming. */
	onCreateProject?(): void;
	/** Commit (or cancel, on blank) the inline rename of a project row. */
	onRenameProject?(projectId: string, name: string): void;
	/** The project whose row is mid inline-rename — its label renders as a
	 *  focused text input instead of static text. */
	renamingProjectId?: string | null;
	/** Whether the shared object menu is available (a shell runtime is
	 *  present). False in preview mode. Project rows carry
	 *  `data-entity-id` and an inert ⋯ button; the right-click + click
	 *  are handled by ONE delegated listener on the stable sidebar slot
	 *  (see `delegated-object-menu.ts`), not per row. */
	objectMenuEnabled: boolean;
};

type BuiltinSurface =
	| TaskSurface.Inbox
	| TaskSurface.Today
	| TaskSurface.Upcoming
	| TaskSurface.Board
	| TaskSurface.Timeline;

const BUILTIN_SURFACES: ReadonlyArray<BuiltinSurface> = [
	TaskSurface.Inbox,
	TaskSurface.Today,
	TaskSurface.Upcoming,
	TaskSurface.Board,
	TaskSurface.Timeline,
];

const SURFACE_LABEL_KEY: Record<BuiltinSurface, string> = {
	[TaskSurface.Inbox]: "tasks.surface.inbox",
	[TaskSurface.Today]: "tasks.surface.today",
	[TaskSurface.Upcoming]: "tasks.surface.upcoming",
	[TaskSurface.Board]: "tasks.surface.board",
	[TaskSurface.Timeline]: "tasks.surface.timeline",
};

function surfaceGlyph(surface: BuiltinSurface): SVGElement {
	const opts = { size: 18, className: "tasks-sidebar__glyph" } as const;
	if (surface === TaskSurface.Today) return createSharedIcon(IconName.KindDate, opts) as SVGElement;
	if (surface === TaskSurface.Inbox) return createTasksIcon(TasksIcon.Inbox, opts);
	if (surface === TaskSurface.Board) return createSharedIcon(IconName.View, opts) as SVGElement;
	if (surface === TaskSurface.Timeline) return createTasksIcon(TasksIcon.Timeline, opts);
	return createTasksIcon(TasksIcon.Upcoming, opts);
}

/** Order `projects` the way the sidebar renders them — manual `sortIndex`
 *  first, then `createdAt` ascending. Exposed for tests. */
export function sortProjects(projects: readonly Project[]): Project[] {
	return [...projects].sort(byManualOrCreated);
}

function byManualOrCreated(a: Project, b: Project): number {
	const ai = typeof a.sortIndex === "number" ? a.sortIndex : null;
	const bi = typeof b.sortIndex === "number" ? b.sortIndex : null;
	if (ai !== null && bi !== null && ai !== bi) return ai - bi;
	if (ai !== null && bi === null) return -1;
	if (bi !== null && ai === null) return 1;
	return a.createdAt - b.createdAt;
}

/** Re-export the shared reorder helper so test imports stay local to
 *  the sidebar (the calculation is the same shape both rules use). */
export { applyReorder as applyProjectReorder };

export function renderSidebar(props: SidebarProps): HTMLElement {
	const aside = document.createElement("aside");
	aside.className = "tasks-sidebar";
	aside.setAttribute("aria-label", t("tasks.sidebar.region"));

	const projects = sortProjects(props.projects);

	// One vertical listbox spans BOTH groups (built-in surfaces + projects) so
	// up/down rove the whole nav and Enter commits the focused surface (same as
	// a click). Each navigable `<button>` row carries a sequential
	// `data-composite-index`; group headings + the rename `<input>` carry none,
	// so the binding skips them. Selection state stays the app's (`aria-current`)
	// — moving the cursor only moves focus, it doesn't switch surface.
	const activate: Array<() => void> = [];
	const cursor = { value: 0 };
	// Roving row buttons are the tab stops, not the container — keep the aside
	// out of the tab order (the binding only defaults a tabindex when none is
	// set, so set it before attaching).
	aside.tabIndex = -1;

	const surfaces = buildSurfaces(props, activate, cursor);
	const projectRows = buildProjectRows(projects, props, activate, cursor);

	aside.appendChild(group(t("tasks.sidebar.surfacesHeading"), surfaces));
	aside.appendChild(projectsGroup(t("tasks.sidebar.projectsHeading"), projectRows, props));

	attachCompositeKeyboard(aside, {
		orientation: Orientation.Vertical,
		// The roving tab stops are the row buttons; keep the container itself out
		// of the tab order (matching the icon-pack picker).
		role: "listbox",
		itemRole: "option",
		// Focus-then-commit: the binding stamps roving tabindex but leaves the
		// active-surface marker (`aria-current`) to the build above.
		selectionAttribute: SelectionAttribute.None,
		itemSelector: ".tasks-sidebar__row[data-composite-index]",
		count: () => activate.length,
		activeIndex: () => cursor.value,
		onActiveIndexChange: (i) => {
			cursor.value = i;
		},
		onActivate: (i) => activate[i]?.(),
	});

	return aside;
}

function group(heading: string, items: HTMLElement[]): HTMLElement {
	const section = document.createElement("section");
	section.className = "tasks-sidebar__group";
	const h = document.createElement("h2");
	h.className = "tasks-sidebar__heading";
	h.textContent = heading;
	section.appendChild(h);
	const list = document.createElement("ul");
	list.className = "tasks-sidebar__list";
	for (const item of items) list.appendChild(item);
	section.appendChild(list);
	return section;
}

function projectsGroup(heading: string, items: HTMLElement[], props: SidebarProps): HTMLElement {
	const section = document.createElement("section");
	section.className = "tasks-sidebar__group tasks-sidebar__group--projects";
	const h = document.createElement("h2");
	h.className = "tasks-sidebar__heading";
	if (props.onCreateProject) {
		// Heading becomes a row: label + trailing "+" — the first-class
		// "new container" affordance mirroring Database / Files (F-035).
		h.classList.add("tasks-sidebar__heading--actionable");
		const label = document.createElement("span");
		label.className = "tasks-sidebar__heading-label";
		label.textContent = heading;
		const add = document.createElement("button");
		add.type = "button";
		add.className = "tasks-sidebar__heading-add";
		add.dataset.bsTooltip = t("tasks.sidebar.newProject");
		add.setAttribute("aria-label", t("tasks.sidebar.newProject"));
		add.appendChild(createSharedIcon(IconName.Plus, { size: 14 }));
		const onCreateProject = props.onCreateProject;
		add.addEventListener("click", () => onCreateProject());
		h.append(label, add);
	} else {
		h.textContent = heading;
	}
	section.appendChild(h);
	const list = document.createElement("ul");
	list.className = "tasks-sidebar__list tasks-sidebar__list--draggable";
	for (const item of items) list.appendChild(item);
	section.appendChild(list);

	if (props.onReorderProjects) {
		const onReorder = props.onReorderProjects;
		wireListDnd({
			list,
			idAttr: "projectId",
			classPrefix: "tasks-sidebar__item",
			onReorder,
		});
	}
	return section;
}

function buildSurfaces(
	props: SidebarProps,
	activate: Array<() => void>,
	cursor: { value: number },
): HTMLElement[] {
	return BUILTIN_SURFACES.map((surface) => {
		const li = document.createElement("li");
		li.className = "tasks-sidebar__item";
		const button = document.createElement("button");
		button.type = "button";
		button.className = "tasks-sidebar__row";
		const isSelected = props.selection.kind === surface;
		// `aria-current` marks the active surface (distinct from the roving
		// focus the binding owns); `aria-pressed` would clash with the
		// `role="option"` the binding stamps.
		if (isSelected) button.setAttribute("aria-current", "true");
		const select = () => props.onSelect({ kind: surface });
		const index = activate.length;
		button.dataset.compositeIndex = String(index);
		if (isSelected) cursor.value = index;
		activate.push(select);
		button.dataset.surface = surface;
		button.addEventListener("click", select);

		button.appendChild(surfaceGlyph(surface));
		const label = document.createElement("span");
		label.className = "tasks-sidebar__label";
		label.textContent = t(SURFACE_LABEL_KEY[surface]);
		button.appendChild(label);

		const count = props.counts.get(surface);
		if (count !== undefined && count > 0) {
			const badge = document.createElement("span");
			badge.className = "tasks-sidebar__badge";
			badge.textContent = String(count);
			button.appendChild(badge);
		}

		li.appendChild(button);
		return li;
	});
}

/** A project row in inline-rename mode (F-035): a focused text input in
 *  place of the label. Enter / blur commits; Escape cancels (a blank value
 *  keeps the current name, so a fresh project is never left nameless). */
function renameProjectRow(
	project: Project,
	onRenameProject: (projectId: string, name: string) => void,
): HTMLElement {
	const li = document.createElement("li");
	li.className = "tasks-sidebar__item tasks-sidebar__item--renaming";
	li.dataset.projectId = project.id;

	const input = document.createElement("input");
	input.type = "text";
	input.className = "tasks-sidebar__rename-input";
	input.value = project.name;
	input.setAttribute("aria-label", t("tasks.sidebar.renameProject"));

	let done = false;
	const commit = (name: string) => {
		if (done) return;
		done = true;
		// Defer the rename out of the blur dispatch (F-254) — `onRenameProject`
		// re-renders the sidebar (`replaceChildren`), and running it while this
		// input is blurring is the "node moved in a blur handler" DOM race.
		queueMicrotask(() => onRenameProject(project.id, name));
	};
	// Enter/Escape commit-or-cancel this editable <input>; the shortcut registry
	// suppresses single keys in editable fields by design.
	// keyboard-exempt
	input.addEventListener("keydown", (event) => {
		const key = event.key; // keyboard-exempt
		if (key === "Enter") {
			event.preventDefault();
			commit(input.value);
		} else if (key === "Escape") {
			event.preventDefault();
			commit("");
		}
	});
	input.addEventListener("blur", () => commit(input.value));
	// The row is attached synchronously after this builder returns; defer
	// focus a frame so `.focus()` lands on a mounted node.
	requestAnimationFrame(() => {
		input.focus();
		input.select();
	});

	li.appendChild(input);
	return li;
}

function buildProjectRows(
	projects: readonly Project[],
	props: SidebarProps,
	activate: Array<() => void>,
	cursor: { value: number },
): HTMLElement[] {
	return projects.map((project) => {
		if (props.onRenameProject && project.id === props.renamingProjectId) {
			// The rename row swaps the button for an `<input>` (a separate focus
			// target) and carries no `data-composite-index`, so the roving
			// binding skips it and never steals keys while the user types.
			return renameProjectRow(project, props.onRenameProject);
		}

		const li = document.createElement("li");
		li.className = "tasks-sidebar__item";
		li.dataset.projectId = project.id;

		const button = document.createElement("button");
		button.type = "button";
		button.className = "tasks-sidebar__row";
		const isSelected =
			props.selection.kind === TaskSurface.Project && props.selection.projectId === project.id;
		if (isSelected) button.setAttribute("aria-current", "true");
		const select = () => props.onSelect({ kind: TaskSurface.Project, projectId: project.id });
		const index = activate.length;
		button.dataset.compositeIndex = String(index);
		if (isSelected) cursor.value = index;
		activate.push(select);
		button.dataset.projectId = project.id;
		button.addEventListener("click", select);

		// Per [[feedback_no_default_type_icon_fallback]] (project-wide):
		// projects without their own `icon` render NO sidebar glyph — not
		// a coloured `·` dot, not a folder default. The row's flex gap
		// collapses around the missing slot and the label slides left.
		const projectIconEl = createEntityIconElement(project.icon ?? null, { size: 14 });
		if (projectIconEl) button.appendChild(projectIconEl);

		const label = document.createElement("span");
		label.className = "tasks-sidebar__label";
		label.textContent = project.name;
		button.appendChild(label);

		const count = props.counts.get(`project.${project.id}`);
		if (count !== undefined && count > 0) {
			const badge = document.createElement("span");
			badge.className = "tasks-sidebar__badge";
			badge.textContent = String(count);
			button.appendChild(badge);
		}

		li.appendChild(button);

		if (props.objectMenuEnabled) {
			li.classList.add("bs-object-menu__host--row");
			li.setAttribute(ENTITY_ID_ATTR, project.id);
			li.setAttribute(ENTITY_TYPE_ATTR, PROJECT_TYPE);
			const more = createMoreButton();
			more.classList.add("tasks-sidebar__more");
			li.appendChild(more);
		}

		if (props.onReorderProjects) {
			li.draggable = true;
			li.setAttribute("aria-grabbed", "false");
			li.classList.add("tasks-sidebar__item--draggable");
		}

		return li;
	});
}
