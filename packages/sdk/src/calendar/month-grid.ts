/**
 * Month grid — 6×7 calendar grid with a per-cell content slot.
 *
 * Three apps shipped near-identical 6×7 grids with their own class
 * namespaces (`.cal-month__*`, `.dbv-cal__*`, `.dbv-cal__mini-*`) — the
 * math came from `@brainstorm-os/sdk/date-grid` but rendering, weekday
 * headers, today/other-month/selected states and weekend tinting each
 * lived per-app. Per `[[feedback_extract_to_sdk_at_copy_two]]` this is
 * the second-copy promotion: the grid renders here, the host supplies
 * what goes *inside* each cell via `renderCell(cell)`.
 *
 * The grid is intentionally chrome-less — no toolbar, no month title,
 * no prev/next. Hosts that already own their toolbar (Calendar.month
 * view, Database.calendar) compose the grid alone; the `MiniCalendar`
 * primitive composes the grid with month-nav chrome for sidebars + date
 * popovers.
 */

import {
	type GridCell,
	WeekStartsOn,
	buildMonthGrid,
	dateKey,
	weekdayLabels as defaultWeekdayLabels,
	isSameDay,
} from "../date-grid/date-grid";

export enum MonthGridDensity {
	/** Full-page month view — large cells, content slot, weekday header. */
	Full = "full",
	/** Year-tile / sidebar mini — small round cells, optional content
	 *  (typically a single dot indicator). */
	Compact = "compact",
}

export type MonthGridCell = GridCell & {
	isSelected: boolean;
	/** Outer cell element. Hosts attach drag-target wiring, data attrs,
	 *  etc. via this handle. `data-date-key` (YYYY-MM-DD) and
	 *  `data-date-epoch-ms` are already set. */
	element: HTMLElement;
	/** Day-number element — `<button>` when `onDateClick` is provided,
	 *  `<span>` otherwise. */
	dateElement: HTMLElement;
	/** Empty container for chips / pills / dots. Hosts append children. */
	contentSlot: HTMLElement;
};

export type MonthGridOptions = {
	/** Any epoch-ms inside the month to render. */
	focusMs: number;
	/** Optional anchor for the "today" highlight. Defaults to `Date.now()`. */
	todayMs?: number;
	/** Optional selected date for the `--selected` highlight. */
	selectedMs?: number | null;
	weekStartsOn?: WeekStartsOn;
	/** Custom weekday short labels in display order (7 entries). Defaults
	 *  to `weekdayLabels(weekStartsOn)` from `date-grid`. */
	weekdayLabels?: ReadonlyArray<string>;
	/** Show the weekday header row. Default `true`. */
	showWeekdays?: boolean;
	density?: MonthGridDensity;
	/** Extra class on the root grid element. */
	className?: string;
	/** Caller fills each cell after the grid mounts. Cell state classes
	 *  (`--today`, `--other-month`, `--weekend`, `--selected`) and
	 *  `data-date-key` / `data-date-epoch-ms` are already applied. */
	renderCell?(cell: MonthGridCell): void;
	/** Click on the date number. When present the date renders as a
	 *  `<button>` (focusable, keyboard-actionable); when absent it
	 *  renders as a `<span>` (decorative). */
	onDateClick?(cell: MonthGridCell, ev: MouseEvent): void;
	/** Click on empty cell space (not on a `<button>`/`<a>`). */
	onEmptyCellClick?(cell: MonthGridCell, ev: MouseEvent): void;
};

export type MonthGridHandle = {
	readonly element: HTMLElement;
	readonly cells: ReadonlyArray<MonthGridCell>;
	update(opts: Partial<MonthGridOptions>): void;
	destroy(): void;
};

const DEFAULT_WEEK_START = WeekStartsOn.Sunday;

export function createMonthGrid(initial: MonthGridOptions): MonthGridHandle {
	const state: MonthGridOptions = { ...initial };

	const root = document.createElement("div");
	let cells: MonthGridCell[] = [];

	const render = (): void => {
		root.replaceChildren();
		const density = state.density ?? MonthGridDensity.Full;
		root.className = rootClass(density, state.className);

		const weekStartsOn = state.weekStartsOn ?? DEFAULT_WEEK_START;
		if (state.showWeekdays !== false) {
			root.appendChild(buildWeekdayRow(weekStartsOn, state.weekdayLabels));
		}

		const grid = document.createElement("div");
		grid.className = "bs-cal-month__grid";

		const todayMs = state.todayMs ?? Date.now();
		const rows = buildMonthGrid(state.focusMs, todayMs, weekStartsOn);
		const built: MonthGridCell[] = [];

		for (const row of rows) {
			for (const raw of row) {
				const cell = buildCell(raw, state.selectedMs ?? null, state);
				state.renderCell?.(cell);
				grid.appendChild(cell.element);
				built.push(cell);
			}
		}

		root.appendChild(grid);
		cells = built;
	};

	render();

	return {
		element: root,
		get cells() {
			return cells;
		},
		update(next) {
			Object.assign(state, next);
			render();
		},
		destroy() {
			root.replaceChildren();
		},
	};
}

function rootClass(density: MonthGridDensity, extra: string | undefined): string {
	const base =
		density === MonthGridDensity.Compact ? "bs-cal-month bs-cal-month--compact" : "bs-cal-month";
	return extra ? `${base} ${extra}` : base;
}

function buildWeekdayRow(
	weekStartsOn: WeekStartsOn,
	override: ReadonlyArray<string> | undefined,
): HTMLElement {
	const row = document.createElement("div");
	row.className = "bs-cal-month__weekdays";
	const labels = override ?? defaultWeekdayLabels(weekStartsOn);
	for (const label of labels) {
		const cell = document.createElement("span");
		cell.className = "bs-cal-month__weekday";
		cell.textContent = label;
		row.appendChild(cell);
	}
	return row;
}

function buildCell(
	raw: GridCell,
	selectedMs: number | null,
	state: Pick<MonthGridOptions, "onDateClick" | "onEmptyCellClick">,
): MonthGridCell {
	const element = document.createElement("div");
	element.className = "bs-cal-month__cell";
	element.dataset.dateKey = raw.dateKey;
	element.dataset.dateEpochMs = String(raw.dateEpochMs);
	if (!raw.inMonth) element.classList.add("bs-cal-month__cell--other-month");
	if (raw.isToday) element.classList.add("bs-cal-month__cell--today");
	if (raw.isWeekend) element.classList.add("bs-cal-month__cell--weekend");

	const isSelected = selectedMs != null && isSameDay(raw.dateEpochMs, selectedMs);
	if (isSelected) element.classList.add("bs-cal-month__cell--selected");

	let dateElement: HTMLElement;
	if (state.onDateClick) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "bs-cal-month__date";
		btn.textContent = String(raw.dayOfMonth);
		dateElement = btn;
	} else {
		const span = document.createElement("span");
		span.className = "bs-cal-month__date";
		span.textContent = String(raw.dayOfMonth);
		dateElement = span;
	}
	element.appendChild(dateElement);

	const contentSlot = document.createElement("div");
	contentSlot.className = "bs-cal-month__content";
	element.appendChild(contentSlot);

	const cell: MonthGridCell = {
		...raw,
		isSelected,
		element,
		dateElement,
		contentSlot,
	};

	if (state.onDateClick) {
		dateElement.addEventListener("click", (ev) => state.onDateClick?.(cell, ev));
	}
	if (state.onEmptyCellClick) {
		element.addEventListener("click", (ev) => {
			if ((ev.target as HTMLElement).closest("button, a, [role='button']")) return;
			state.onEmptyCellClick?.(cell, ev);
		});
	}

	return cell;
}

export { dateKey, WeekStartsOn };
