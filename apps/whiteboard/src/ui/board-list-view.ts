/**
 * Board-switcher list view for the left object-navigation sidebar (B8.2).
 * Renders one row per board and wires the shared `@brainstorm-os/sdk/a11y`
 * composite-keyboard binding so Arrow keys rove a cursor across the rows
 * (vertical listbox) and Enter / Space switches to the focused board —
 * the same effect as a click. The container + row roles + roving tabindex
 * are stamped by the binding (KBN-A), not hand-written here.
 *
 * Kept out of `app.ts` so the DOM list + keyboard contract is jsdom-tested
 * without mounting the Pixi canvas app.
 */

import { Orientation, attachCompositeKeyboard } from "@brainstorm-os/sdk/a11y";
import type { CompositeKeyboardHandle } from "@brainstorm-os/sdk/a11y";
import { createEntityIconElement } from "@brainstorm-os/sdk/entity-icon";
import type { Whiteboard } from "../types/whiteboard";

export type BoardListViewOptions = {
	/** Boards in display order (already filtered + sorted by the caller). */
	boards: readonly Whiteboard[];
	/** Id of the currently-open board — seeds the cursor + the active row. */
	activeBoardId: string;
	/** Switch to the board at `index` (same as a row click). */
	onOpen(boardId: string): void;
};

export type BoardListViewHandle = {
	destroy(): void;
};

/** Render the board rows into `list` and attach the composite keyboard.
 *  `list` is replaced wholesale; the caller owns the empty-state path. */
export function renderBoardListView(
	list: HTMLElement,
	opts: BoardListViewOptions,
): BoardListViewHandle {
	const { boards, activeBoardId, onOpen } = opts;
	list.replaceChildren();

	boards.forEach((board, index) => {
		const row = document.createElement("button");
		row.type = "button";
		row.className = "whiteboard__nav-row";
		row.dataset.compositeIndex = String(index);
		if (board.id === activeBoardId) row.classList.add("whiteboard__nav-row--active");
		const icon = createEntityIconElement(board.icon ?? null, { size: 16 });
		if (icon) {
			icon.classList.add("whiteboard__nav-row-icon");
			row.appendChild(icon);
		}
		const name = document.createElement("span");
		name.className = "whiteboard__nav-row-name";
		name.textContent = board.name;
		name.title = board.name;
		row.appendChild(name);
		row.addEventListener("click", () => onOpen(board.id));
		list.appendChild(row);
	});

	// Cursor seeds on the open board; Arrow keys move it, Enter / Space (or a
	// click) switches boards — switching re-renders the list, which re-stamps.
	let cursor = Math.max(
		0,
		boards.findIndex((b) => b.id === activeBoardId),
	);
	const handle: CompositeKeyboardHandle = attachCompositeKeyboard(list, {
		orientation: Orientation.Vertical,
		count: () => boards.length,
		activeIndex: () => cursor,
		onActiveIndexChange: (i) => {
			cursor = i;
		},
		onActivate: (i) => {
			const board = boards[i];
			if (board) onOpen(board.id);
		},
	});

	return {
		destroy() {
			handle.destroy();
		},
	};
}
