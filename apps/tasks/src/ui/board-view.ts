/**
 * Status board view (9.14.10) — renders the `compileBoard` columns as a
 * horizontal kanban. Each card is the app-provided row element (so cards behave
 * exactly like list rows — same chips, click-to-open, ⋯ menu); the board only
 * adds the column chrome + drag-to-change-status + a per-column inline add
 * (F-207 — a task created from a column carries that column's status, so the
 * board is a real capture surface). Dropping a card on a column sets the
 * task's `statusKey` to that column's key.
 *
 * KBN-A-tasks (12.4): the board is keyboard-drivable as a sparse 2-D grid via
 * the shared `attachCompositeKeyboard` binding with `Orientation.Spatial` —
 * Left/Right move between columns, Up/Down between cards in a column (nearest in
 * direction), Enter opens the focused card, and the cursor follows
 * `selectedTaskId`. The substrate stamps the `listbox`/`option` roles + roving
 * tabindex; the columns are plain `group`s.
 */

import { Orientation, type SpatialCell, attachCompositeKeyboard } from "@brainstorm-os/sdk/a11y";
import { t } from "../i18n/t";
import type { BoardColumn } from "../logic/compile-board";
import type { Task } from "../types/task";

/** Board-local drag MIME — distinct from the cross-app entity drag so a card
 *  drag is only ever a status move within the board. */
const CARD_MIME = "application/x-brainstorm-task-card";

export type BoardViewProps = {
	columns: readonly BoardColumn[];
	/** Human label for a column's status key. */
	labelFor(key: string): string;
	/** Render one task as a card body (the app passes a configured row). */
	renderCard(task: Task): HTMLElement;
	/** Move a task to a column's status. */
	onMoveToStatus(taskId: string, statusKey: string): void;
	/** Create a task with a column's status (the column's inline add, F-207).
	 *  Absent in preview mode — the columns then render no add affordance. */
	onAddTask?(name: string, statusKey: string): void;
	/** The task whose card the keyboard cursor sits on (mirrors the list). */
	selectedTaskId?: string | null;
	/** Cursor moved to a card — select it (same as a card click → inspector). */
	onSelectTask?(task: Task): void;
	/** Enter on the focused card — open it for editing (same as the open action). */
	onOpenEdit?(task: Task): void;
};

export function renderBoardView(props: BoardViewProps): HTMLElement {
	const board = document.createElement("div");
	board.className = "tasks-board";
	board.setAttribute("aria-label", t("tasks.board.region"));

	// Flatten cards in render order (column-major) so `data-composite-index`
	// aligns with the spatial `{col, row}` cells the binding navigates.
	const flat: { task: Task; col: number; row: number }[] = [];
	props.columns.forEach((column, col) => {
		board.appendChild(renderColumn(column, props));
		column.tasks.forEach((task, row) => flat.push({ task, col, row }));
	});

	if (flat.length > 0 && props.onSelectTask && props.onOpenEdit) {
		const onSelectTask = props.onSelectTask;
		const onOpenEdit = props.onOpenEdit;
		flat.forEach((entry, index) => {
			const card = board.querySelector<HTMLElement>(
				`.tasks-board__card[data-task-id="${entry.task.id}"]`,
			);
			if (card) card.dataset.compositeIndex = String(index);
		});
		const cells: SpatialCell[] = flat.map((e) => ({ col: e.col, row: e.row }));
		let cursor = Math.max(
			0,
			flat.findIndex((e) => e.task.id === props.selectedTaskId),
		);
		attachCompositeKeyboard(board, {
			orientation: Orientation.Spatial,
			itemSelector: ".tasks-board__card[data-composite-index]",
			count: () => flat.length,
			cells: () => cells,
			activeIndex: () => cursor,
			onActiveIndexChange: (i) => {
				cursor = i;
				const entry = flat[i];
				if (entry) onSelectTask(entry.task);
			},
			onActivate: (i) => {
				const entry = flat[i];
				if (entry) onOpenEdit(entry.task);
			},
		});
	}
	return board;
}

function renderColumn(column: BoardColumn, props: BoardViewProps): HTMLElement {
	const el = document.createElement("section");
	el.className = "tasks-board__column";
	el.dataset.statusKey = column.key;
	el.setAttribute("role", "group");
	el.setAttribute("aria-label", props.labelFor(column.key));

	const header = document.createElement("div");
	header.className = "tasks-board__column-header";
	const label = document.createElement("span");
	label.className = "tasks-board__column-label";
	label.textContent = props.labelFor(column.key);
	const count = document.createElement("span");
	count.className = "tasks-board__column-count";
	count.textContent = String(column.tasks.length);
	header.append(label, count);
	el.appendChild(header);

	const list = document.createElement("div");
	list.className = "tasks-board__cards";
	if (column.tasks.length === 0) {
		const empty = document.createElement("div");
		empty.className = "tasks-board__empty";
		empty.textContent = t("tasks.board.empty");
		list.appendChild(empty);
	}
	for (const task of column.tasks) {
		list.appendChild(renderCard(task, props));
	}
	el.appendChild(list);

	if (props.onAddTask) {
		el.appendChild(renderColumnAdd(column.key, props.onAddTask));
	}

	// Drop target: accept a card drag, move it to this column's status.
	el.addEventListener("dragover", (e) => {
		if (!e.dataTransfer?.types.includes(CARD_MIME)) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = "move";
		el.dataset.dropTarget = "true";
	});
	el.addEventListener("dragleave", (e) => {
		// Only clear when leaving the column itself (not moving between children).
		if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return;
		delete el.dataset.dropTarget;
	});
	el.addEventListener("drop", (e) => {
		const taskId = e.dataTransfer?.getData(CARD_MIME);
		delete el.dataset.dropTarget;
		if (!taskId) return;
		e.preventDefault();
		props.onMoveToStatus(taskId, column.key);
	});

	return el;
}

/** Per-column inline add (F-207). A quiet button that swaps to a single-input
 *  form; Enter commits via the form's native implicit submission, blur commits
 *  a non-empty name and otherwise reverts, Escape cancels without creating —
 *  the same contract as the row's inline rename. The app re-renders the board
 *  on add, so the affordance resets to the button by itself. */
function renderColumnAdd(
	statusKey: string,
	onAddTask: (name: string, statusKey: string) => void,
): HTMLElement {
	const host = document.createElement("div");
	host.className = "tasks-board__add";

	const button = document.createElement("button");
	button.type = "button";
	button.className = "tasks-board__add-button";
	button.textContent = t("tasks.board.addTask");
	host.appendChild(button);

	button.addEventListener("click", () => {
		const form = document.createElement("form");
		form.className = "tasks-board__add-form";
		const input = document.createElement("input");
		input.type = "text";
		input.className = "tasks-board__add-input";
		input.placeholder = t("tasks.board.addPlaceholder");
		input.setAttribute("aria-label", t("tasks.board.addTask"));
		input.autocomplete = "off";
		input.spellcheck = false;
		form.appendChild(input);

		let settled = false;
		const commit = (): void => {
			if (settled) return;
			settled = true;
			const name = input.value.trim();
			// Restore the DOM first, then defer the reactive add out of the blur
			// dispatch (F-254 — `onAddTask` re-renders the board; running it inside
			// blur while this form/button is swapping is the "node moved in a blur
			// handler" race).
			form.replaceWith(button);
			if (name.length > 0) queueMicrotask(() => onAddTask(name, statusKey));
		};
		const cancel = (): void => {
			if (settled) return;
			settled = true;
			form.replaceWith(button);
			button.focus();
		};
		form.addEventListener("submit", (event) => {
			event.preventDefault();
			commit();
		});
		// Escape cancels this editable <input>; the shortcut registry suppresses
		// single keys in editable fields by design (same as the sidebar rename).
		// keyboard-exempt
		input.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				// keyboard-exempt
				event.preventDefault();
				cancel();
			}
		});
		input.addEventListener("blur", commit);

		button.replaceWith(form);
		input.focus();
	});

	return host;
}

function renderCard(task: Task, props: BoardViewProps): HTMLElement {
	const card = document.createElement("div");
	card.className = "tasks-board__card";
	card.draggable = true;
	card.dataset.taskId = task.id;
	card.appendChild(props.renderCard(task));
	card.addEventListener("dragstart", (e) => {
		if (!e.dataTransfer) return;
		e.dataTransfer.setData(CARD_MIME, task.id);
		e.dataTransfer.setData("text/plain", task.name);
		e.dataTransfer.effectAllowed = "move";
		card.dataset.dragging = "true";
	});
	card.addEventListener("dragend", () => {
		delete card.dataset.dragging;
	});
	return card;
}
