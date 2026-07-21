/**
 * Mini-calendar — compact date-picker primitive: month grid + title +
 * prev/next nav. Used by sidebars (Calendar app, Tasks date popover,
 * Notes property cell) and any anchored date-picker popover.
 *
 * Composed on top of `createMonthGrid` so the grid math + visual style
 * stay shared with full-page month views. The nav-button glyphs come
 * from `@brainstorm-os/sdk/icon` so RTL flipping is wired once.
 */

import { type WeekStartsOn, addMonths } from "../date-grid/date-grid";
import { createDatePager } from "../date-pager/date-pager";
import { defaultMiniWeekdays } from "./mini-weekdays";
import {
	type MonthGridCell,
	MonthGridDensity,
	type MonthGridHandle,
	createMonthGrid,
} from "./month-grid";

export type MiniCalendarLabels = {
	/** Text on the "today" button (e.g. `"Today"`). */
	today: string;
	/** aria-label for the prev-month arrow. */
	prev: string;
	/** aria-label for the next-month arrow. */
	next: string;
};

export type MiniCalendarOptions = {
	labels: MiniCalendarLabels;
	/** Currently-selected date. `null` = nothing selected. */
	valueMs?: number | null;
	/** Which month is shown. Defaults to `valueMs ?? todayMs ?? Date.now()`. */
	viewMs?: number;
	/** Anchor for the "today" highlight. Defaults to `Date.now()`. */
	todayMs?: number;
	weekStartsOn?: WeekStartsOn;
	/** Custom weekday short labels (7 entries). When omitted defaults to
	 *  the first letter of each `weekdayLabels()` label — typical mini-
	 *  calendar density. */
	weekdayLabels?: ReadonlyArray<string>;
	/** Optional override for the title text. Default
	 *  `toLocaleDateString({ month: "long", year: "numeric" })`. */
	formatTitle?(viewMs: number): string;
	className?: string;
	/** Whether to render the title + prev/next header. Default `true`. */
	showHeader?: boolean;
	/** Decorate each day cell after it mounts — e.g. an entry-presence dot.
	 *  Runs for every visible cell (in + out of month). The compact cell is
	 *  `position: relative`, so an absolutely-positioned indicator appended
	 *  to `cell.element` rides under the day number without disturbing the
	 *  round-cell layout. */
	renderCell?(cell: MonthGridCell): void;
	onSelect?(epochMs: number, ev?: MouseEvent): void;
	onViewChange?(viewMs: number): void;
};

export type MiniCalendarHandle = {
	readonly element: HTMLElement;
	/** Currently-shown month anchor. */
	readonly viewMs: number;
	/** Currently-selected date or `null`. */
	readonly valueMs: number | null;
	setValue(epochMs: number | null): void;
	setView(epochMs: number): void;
	destroy(): void;
};

export function createMiniCalendar(initial: MiniCalendarOptions): MiniCalendarHandle {
	const root = document.createElement("section");
	root.className = initial.className ? `bs-cal-mini ${initial.className}` : "bs-cal-mini";

	const todayMs = initial.todayMs ?? Date.now();
	let viewMs = initial.viewMs ?? initial.valueMs ?? todayMs;
	let valueMs = initial.valueMs ?? null;

	let titleEl: HTMLElement | null = null;
	let grid: MonthGridHandle | null = null;

	const formatTitle =
		initial.formatTitle ??
		((ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "long", year: "numeric" }));

	if (initial.showHeader !== false) {
		const header = document.createElement("div");
		header.className = "bs-cal-mini__header";

		// `today | ‹ | ›` cluster + trailing month label — the shared
		// `@brainstorm-os/sdk/date-pager` chrome, so the cluster reads
		// identically across every host that shows a mini-calendar.
		const pager = createDatePager({
			labels: { today: initial.labels.today, prev: initial.labels.prev, next: initial.labels.next },
			onToday: () => goToday(),
			onPrev: () => stepMonth(-1),
			onNext: () => stepMonth(1),
			className: "bs-cal-mini__pager",
			iconSize: 14,
		});
		header.appendChild(pager.root);

		const title = document.createElement("span");
		title.className = "bs-cal-mini__title";
		title.textContent = formatTitle(viewMs);
		header.appendChild(title);
		titleEl = title;

		root.appendChild(header);
	}

	const gridHost = document.createElement("div");
	gridHost.className = "bs-cal-mini__body";
	root.appendChild(gridHost);

	const buildGrid = (): void => {
		grid?.destroy();
		const gridOpts: Parameters<typeof createMonthGrid>[0] = {
			focusMs: viewMs,
			selectedMs: valueMs,
			weekdayLabels: initial.weekdayLabels ?? defaultMiniWeekdays(initial.weekStartsOn),
			density: MonthGridDensity.Compact,
			onDateClick: (cell, ev) => {
				valueMs = cell.dateEpochMs;
				initial.onSelect?.(cell.dateEpochMs, ev);
				render();
			},
		};
		if (initial.renderCell) gridOpts.renderCell = initial.renderCell;
		if (initial.weekStartsOn !== undefined) gridOpts.weekStartsOn = initial.weekStartsOn;
		gridOpts.todayMs = todayMs;
		grid = createMonthGrid(gridOpts);
		gridHost.replaceChildren(grid.element);
	};

	const render = (): void => {
		if (titleEl) titleEl.textContent = formatTitle(viewMs);
		buildGrid();
	};

	const stepMonth = (delta: number): void => {
		viewMs = addMonths(viewMs, delta);
		initial.onViewChange?.(viewMs);
		render();
	};

	const goToday = (): void => {
		valueMs = todayMs;
		viewMs = todayMs;
		initial.onViewChange?.(viewMs);
		initial.onSelect?.(todayMs);
		render();
	};

	buildGrid();

	return {
		element: root,
		get viewMs() {
			return viewMs;
		},
		get valueMs() {
			return valueMs;
		},
		setValue(ms) {
			valueMs = ms;
			render();
		},
		setView(ms) {
			viewMs = ms;
			initial.onViewChange?.(viewMs);
			render();
		},
		destroy() {
			grid?.destroy();
			root.replaceChildren();
		},
	};
}
