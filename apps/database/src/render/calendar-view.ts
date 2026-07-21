/**
 * Calendar view renderer — entities placed on a date axis. Per
 * ` §Calendar`.
 *
 * Range switch (week / month / year) drives both the grid layout and the
 * prev/next semantics. Week renders a horizontal 7-cell row; month renders
 * the classic 6-row grid; year renders 12 mini-month tiles with per-day
 * dots. Day count badges in year mode roll up to "+N" pills.
 *
 * Selection + drag-and-drop: pills are draggable; cells accept drops and
 * call `onMove(entity, dayStart)` so the host can write the date property.
 */

import { birthdayOccurrencesInRange } from "@brainstorm-os/sdk-types";
import { attachGridCellKeyboard } from "@brainstorm-os/sdk/a11y";
import { MonthGridDensity, createMonthGrid } from "@brainstorm-os/sdk/calendar";
import { WeekStartsOn } from "@brainstorm-os/sdk/date-grid";
import { createDatePager } from "@brainstorm-os/sdk/date-pager";
import { plural, t } from "../i18n";
import type { CompiledView } from "../logic/compile-view";
import type { EntityRow } from "../logic/in-memory-entities";
import { readPropertyPath } from "../logic/in-memory-entities";
import { resolveVocabularyColor as vocabularyColor } from "../logic/property-resolver";
import type { CalendarLayoutOptions, GroupBy } from "../types/list-view";
import { CalendarRange, CalendarRecurring, CalendarWeekStart } from "../types/list-view";
import { entityIcon, entityTitle } from "./cells";

const DAY_MS = 24 * 60 * 60 * 1000;

export type CalendarViewProps = {
	compiled: CompiledView;
	layout: CalendarLayoutOptions;
	groupBy: GroupBy;
	cursorMonth: number;
	selectedIds: ReadonlySet<string>;
	onSelect: (entity: EntityRow, modifiers: { shiftKey: boolean; metaKey: boolean }) => void;
	onOpen: (entity: EntityRow) => void;
	onPrev: () => void;
	onNext: () => void;
	onToday: () => void;
	onRangeChange: (range: CalendarRange) => void;
	onMoveToDay: (entity: EntityRow, dayStart: number) => void;
};

export function renderCalendarView(host: HTMLElement, props: CalendarViewProps): void {
	host.replaceChildren();
	host.classList.add("dbv-calendar");
	host.dataset.range = props.layout.range;

	host.appendChild(renderToolbar(props));

	switch (props.layout.range) {
		case CalendarRange.Week:
			host.appendChild(renderWeekView(props));
			break;
		case CalendarRange.Year:
			host.appendChild(renderYearView(props));
			break;
		default:
			host.appendChild(renderMonthView(props));
			break;
	}
}

/* ── Toolbar ─────────────────────────────────────────────────────────── */

function renderToolbar(props: CalendarViewProps): HTMLElement {
	const toolbar = document.createElement("header");
	toolbar.className = "dbv-cal__toolbar";

	const title = document.createElement("h3");
	title.className = "dbv-cal__title";
	title.textContent = formatRangeTitle(props);
	toolbar.appendChild(title);

	const right = document.createElement("div");
	right.className = "dbv-cal__toolbar-right";

	const segments = document.createElement("div");
	segments.className = "dbv-cal__segments";
	for (const range of [CalendarRange.Week, CalendarRange.Month, CalendarRange.Year]) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "dbv-cal__segment";
		btn.dataset.active = String(props.layout.range === range);
		btn.textContent = rangeLabel(range);
		btn.addEventListener("click", () => props.onRangeChange(range));
		segments.appendChild(btn);
	}
	right.appendChild(segments);

	// Third-copy promotion to `@brainstorm-os/sdk/date-pager` (the cluster
	// also lives in Calendar header + Journal day-strip). Database keeps
	// the legacy `dbv-cal__controls` class on the root so existing layout
	// CSS keeps working.
	const controls = createDatePager({
		labels: { today: "Today", prev: "Previous", next: "Next" },
		onToday: () => props.onToday(),
		onPrev: () => props.onPrev(),
		onNext: () => props.onNext(),
		className: "dbv-cal__controls",
	}).root;
	right.appendChild(controls);
	toolbar.appendChild(right);

	return toolbar;
}

function rangeLabel(range: CalendarRange): string {
	switch (range) {
		case CalendarRange.Week:
			return "Week";
		case CalendarRange.Month:
			return "Month";
		case CalendarRange.Year:
			return "Year";
		case CalendarRange.Day:
			return "Day";
		case CalendarRange.Agenda:
			return "Agenda";
	}
}

function formatRangeTitle(props: CalendarViewProps): string {
	const cursor = new Date(props.cursorMonth);
	if (props.layout.range === CalendarRange.Week) {
		const start = weekStart(cursor, props.layout.startWeekOn);
		const end = new Date(start);
		end.setDate(end.getDate() + 6);
		const sameMonth = start.getMonth() === end.getMonth();
		const startLabel = start.toLocaleDateString(undefined, {
			month: "short",
			day: "numeric",
		});
		const endLabel = sameMonth
			? `${end.getDate()}, ${end.getFullYear()}`
			: end.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
		return `${startLabel} – ${endLabel}`;
	}
	if (props.layout.range === CalendarRange.Year) {
		return String(cursor.getFullYear());
	}
	return cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

/* ── Month view ──────────────────────────────────────────────────────── */

function renderMonthView(props: CalendarViewProps): HTMLElement {
	const wrap = document.createElement("div");
	wrap.className = "dbv-cal__monthwrap";

	const cursor = new Date(props.cursorMonth);
	cursor.setDate(1);
	cursor.setHours(0, 0, 0, 0);
	const monthStart = cursor.getTime();

	const weekStarts =
		props.layout.startWeekOn === CalendarWeekStart.Sunday ? WeekStartsOn.Sunday : WeekStartsOn.Monday;
	const firstWeekday = (cursor.getDay() - (weekStarts as number) + 7) % 7;
	const gridStart = monthStart - firstWeekday * DAY_MS;

	const byDay = bucketByDay(props.compiled.rows, props.layout.primaryDateProperty, {
		recurring: props.layout.recurring,
		windowStart: gridStart,
		windowEnd: gridStart + 42 * DAY_MS,
	});

	const maxPills = 3;
	const grid = createMonthGrid({
		focusMs: monthStart,
		todayMs: Date.now(),
		weekStartsOn: weekStarts,
		renderCell: (cell) => {
			attachDayDrop(cell.element, cell.dateEpochMs, props);

			const pills = document.createElement("div");
			pills.className = "dbv-cal__pills";
			const items = byDay.get(cell.dateEpochMs) ?? [];
			for (let j = 0; j < items.length && j < maxPills; j += 1) {
				const entity = items[j];
				if (!entity) continue;
				pills.appendChild(renderPill(entity, props));
			}
			if (items.length > maxPills) {
				const more = document.createElement("span");
				more.className = "dbv-cal__more";
				more.textContent = t("brainstorm.database.calendar.more", {
					count: items.length - maxPills,
				});
				pills.appendChild(more);
			}
			cell.contentSlot.appendChild(pills);
		},
	});

	wrap.appendChild(grid.element);

	// KBN-A-database (12.4): arrow-navigable month grid — the cursor moves
	// day-to-day, Enter opens the first record on the focused day. Grid
	// container holds focus (aria-activedescendant); pills stay mouse-only.
	const gridEl = grid.element.querySelector<HTMLElement>(".bs-cal-month__grid");
	if (gridEl) {
		attachGridCellKeyboard(gridEl, ".bs-cal-month__cell", {
			columns: 7,
			initialIndex: firstWeekday,
			onOpenCell: (cell) => {
				const day = Number(cell.dataset.dateEpochMs);
				const first = byDay.get(day)?.[0];
				if (first) props.onOpen(first);
			},
		});
	}

	return wrap;
}

/* ── Week view ───────────────────────────────────────────────────────── */

function renderWeekView(props: CalendarViewProps): HTMLElement {
	const wrap = document.createElement("div");
	wrap.className = "dbv-cal__weekwrap";

	const cursor = new Date(props.cursorMonth);
	const start = weekStart(cursor, props.layout.startWeekOn);

	const weekStartsIdx = props.layout.startWeekOn === CalendarWeekStart.Sunday ? 0 : 1;
	wrap.appendChild(renderWeekdayHeader(weekStartsIdx));

	const grid = document.createElement("div");
	grid.className = "dbv-cal__weekgrid";

	const byDay = bucketByDay(props.compiled.rows, props.layout.primaryDateProperty, {
		recurring: props.layout.recurring,
		windowStart: start.getTime(),
		windowEnd: start.getTime() + 7 * DAY_MS,
	});

	for (let i = 0; i < 7; i += 1) {
		const dayStart = startOfDay(start.getTime() + i * DAY_MS);
		const date = new Date(dayStart);
		const isToday = isSameDay(dayStart, Date.now());

		const cell = createDayCell(dayStart, props, { today: isToday });
		cell.classList.add("dbv-cal__weekcell");

		const dayLine = document.createElement("div");
		dayLine.className = "dbv-cal__weekday-num";
		dayLine.textContent = date.toLocaleDateString(undefined, {
			weekday: "short",
			day: "numeric",
		});
		cell.appendChild(dayLine);

		const pills = document.createElement("div");
		pills.className = "dbv-cal__pills dbv-cal__pills--stack";
		const items = byDay.get(dayStart) ?? [];
		for (const entity of items) {
			pills.appendChild(renderPill(entity, props));
		}
		if (items.length === 0) {
			const empty = document.createElement("span");
			empty.className = "dbv-cal__weekempty";
			empty.textContent = "—";
			pills.appendChild(empty);
		}
		cell.appendChild(pills);
		grid.appendChild(cell);
	}
	wrap.appendChild(grid);

	// KBN-A-database (12.4): the 7 day cells form a single-row grid —
	// Left/Right move day-to-day, Enter opens the focused day's first record.
	attachGridCellKeyboard(grid, ".dbv-cal__weekcell", {
		columns: 7,
		onOpenCell: (cell) => {
			const day = Number(cell.dataset.dayStart);
			const first = byDay.get(day)?.[0];
			if (first) props.onOpen(first);
		},
	});

	return wrap;
}

/* ── Year view ───────────────────────────────────────────────────────── */

function renderYearView(props: CalendarViewProps): HTMLElement {
	const wrap = document.createElement("div");
	wrap.className = "dbv-cal__yearwrap";

	const cursor = new Date(props.cursorMonth);
	const year = cursor.getFullYear();
	const weekStarts =
		props.layout.startWeekOn === CalendarWeekStart.Sunday ? WeekStartsOn.Sunday : WeekStartsOn.Monday;
	const weekStartsIdx = weekStarts as number;
	const byDay = bucketByDay(props.compiled.rows, props.layout.primaryDateProperty, {
		recurring: props.layout.recurring,
		windowStart: new Date(year, 0, 1).getTime(),
		windowEnd: new Date(year + 1, 0, 1).getTime(),
	});

	const narrowLabels = (() => {
		const all = ["S", "M", "T", "W", "T", "F", "S"];
		const out: string[] = new Array(7);
		for (let i = 0; i < 7; i += 1) out[i] = all[(weekStartsIdx + i) % 7] ?? "";
		return out;
	})();

	for (let m = 0; m < 12; m += 1) {
		const monthTile = document.createElement("section");
		monthTile.className = "dbv-cal__month-tile";

		const monthDate = new Date(year, m, 1);
		const title = document.createElement("h4");
		title.className = "dbv-cal__month-tile-title";
		title.textContent = monthDate.toLocaleDateString(undefined, { month: "long" });
		monthTile.appendChild(title);

		const todayMs = Date.now();
		const colorProp = props.layout.colorBy ?? props.groupBy.propertyId;

		const grid = createMonthGrid({
			focusMs: monthDate.getTime(),
			todayMs,
			weekStartsOn: weekStarts,
			density: MonthGridDensity.Compact,
			weekdayLabels: narrowLabels,
			renderCell: (cell) => {
				const items = byDay.get(cell.dateEpochMs) ?? [];
				if (items.length === 0 || !cell.inMonth) return;
				cell.element.dataset.hasItems = "true";

				const dot = document.createElement("span");
				dot.className = "dbv-cal__mini-dot";
				const first = items[0];
				if (first) {
					const value = first.properties[colorProp];
					const color = typeof value === "string" ? vocabularyColor(colorProp, value) : null;
					if (color) dot.style.background = color;
				}
				cell.contentSlot.appendChild(dot);
				cell.contentSlot.style.display = "block";

				cell.element.title = plural(
					items.length,
					"brainstorm.database.calendar.dayItems.one",
					"brainstorm.database.calendar.dayItems.other",
				);
				cell.element.addEventListener("click", (event) => {
					event.stopPropagation();
					if (items.length === 1 && items[0]) {
						props.onSelect(items[0], { shiftKey: event.shiftKey, metaKey: event.metaKey });
					}
				});
				cell.element.addEventListener("dblclick", (event) => {
					event.stopPropagation();
					if (items.length >= 1 && items[0]) props.onOpen(items[0]);
				});
			},
		});

		monthTile.appendChild(grid.element);
		wrap.appendChild(monthTile);

		// KBN-A-database: each year-view month tile is its own arrow-navigable
		// grid (matching month/week). The cursor steps day-to-day; Enter opens
		// the first record on the focused day, the same affordance as the
		// double-click above. Tiles are independent grids — arrows do not jump
		// between months (that's the prev/next pager's job).
		const tileGrid = grid.element.querySelector<HTMLElement>(".bs-cal-month__grid");
		if (tileGrid) {
			attachGridCellKeyboard(tileGrid, ".bs-cal-month__cell", {
				columns: 7,
				onOpenCell: (cell) => {
					const day = Number(cell.dataset.dateEpochMs);
					const first = byDay.get(day)?.[0];
					if (first) props.onOpen(first);
				},
			});
		}
	}
	return wrap;
}

/* ── Shared helpers ─────────────────────────────────────────────────── */

function renderWeekdayHeader(weekStartsIdx: number): HTMLElement {
	const weekHeader = document.createElement("div");
	weekHeader.className = "dbv-cal__weekrow";
	const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
	for (let i = 0; i < 7; i += 1) {
		const idx = (weekStartsIdx + i) % 7;
		const label = document.createElement("span");
		label.className = "dbv-cal__weekday";
		label.textContent = weekdayLabels[idx] ?? "";
		weekHeader.appendChild(label);
	}
	return weekHeader;
}

function createDayCell(
	dayStart: number,
	props: CalendarViewProps,
	flags: { otherMonth?: boolean; today?: boolean },
): HTMLElement {
	const cell = document.createElement("div");
	cell.className = "dbv-cal__cell";
	if (flags.otherMonth) cell.dataset.otherMonth = "true";
	if (flags.today) cell.dataset.today = "true";
	cell.dataset.dayStart = String(dayStart);
	attachDayDrop(cell, dayStart, props);
	return cell;
}

function attachDayDrop(cell: HTMLElement, dayStart: number, props: CalendarViewProps): void {
	cell.addEventListener("dragover", (event) => {
		if (!event.dataTransfer) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "move";
		cell.dataset.dropping = "true";
	});
	cell.addEventListener("dragleave", () => {
		delete cell.dataset.dropping;
	});
	cell.addEventListener("drop", (event) => {
		event.preventDefault();
		delete cell.dataset.dropping;
		const entityId = event.dataTransfer?.getData("application/x-brainstorm-entity");
		if (!entityId) return;
		const entity = props.compiled.rows.find((e) => e.id === entityId);
		if (!entity) return;
		props.onMoveToDay(entity, dayStart);
	});
}

function renderPill(entity: EntityRow, props: CalendarViewProps): HTMLElement {
	const pill = document.createElement("button");
	pill.type = "button";
	pill.className = "dbv-cal__pill";
	pill.dataset.entityId = entity.id;
	if (props.selectedIds.has(entity.id)) pill.dataset.selected = "true";
	pill.draggable = true;

	const colorProp = props.layout.colorBy ?? props.groupBy.propertyId;
	const value = entity.properties[colorProp];
	const color = typeof value === "string" ? vocabularyColor(colorProp, value) : null;
	if (color) {
		pill.style.background = `color-mix(in srgb, ${color} 22%, transparent)`;
		pill.style.color = color;
		pill.style.borderColor = `color-mix(in srgb, ${color} 42%, transparent)`;
	}
	const title = entityTitle(entity);
	const pillIconEl = entityIcon(entity, 12);
	const label = document.createElement("span");
	label.className = "dbv-cal__pill-label";
	label.textContent = title;
	if (pillIconEl) {
		const glyph = document.createElement("span");
		glyph.className = "dbv-cal__pill-glyph";
		glyph.appendChild(pillIconEl);
		pill.append(glyph, label);
	} else {
		pill.append(label);
	}
	pill.title = title;
	pill.addEventListener("click", (event) => {
		event.stopPropagation();
		props.onSelect(entity, { shiftKey: event.shiftKey, metaKey: event.metaKey || event.ctrlKey });
	});
	pill.addEventListener("dblclick", (event) => {
		event.stopPropagation();
		props.onOpen(entity);
	});
	pill.addEventListener("dragstart", (event) => {
		event.dataTransfer?.setData("application/x-brainstorm-entity", entity.id);
		if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
	});
	return pill;
}

export type BucketOptions = {
	/** When `Yearly`, the row's date property is a day-of-year: it lands
	 *  on the displayed period's occurrence (per the shared 9.15.5
	 *  engine), not the absolute stored year. */
	recurring?: CalendarRecurring | undefined;
	/** Visible window (epoch ms) the recurring projection materializes
	 *  into — the period each view already computes. Unused by the
	 *  non-recurring path so its behaviour is byte-identical. */
	windowStart: number;
	windowEnd: number;
};

function pushDay(map: Map<number, EntityRow[]>, day: number, entity: EntityRow): void {
	const bucket = map.get(day);
	if (bucket) bucket.push(entity);
	else map.set(day, [entity]);
}

/** Exported for unit testing — the recurrence-aware bucketing is the
 *  keystone of the 9.12.13(b) Birthdays-view wiring. */
export function bucketByDay(
	rows: ReadonlyArray<EntityRow>,
	propertyId: string,
	opts: BucketOptions,
): Map<number, EntityRow[]> {
	const map = new Map<number, EntityRow[]>();
	for (const entity of rows) {
		const ms = readMs(readPropertyPath(entity, propertyId));
		if (ms === null) continue;
		if (opts.recurring === CalendarRecurring.Yearly) {
			// One single instance per displayed period — a 6-week month
			// grid / 7-day week / 12-month year never repeats a month-day,
			// so selection + drag-to-set semantics stay one-row-per-bucket.
			for (const occ of birthdayOccurrencesInRange(ms, opts.windowStart, opts.windowEnd)) {
				pushDay(map, startOfDay(occ), entity);
			}
			continue;
		}
		pushDay(map, startOfDay(ms), entity);
	}
	return map;
}

function readMs(value: unknown): number | null {
	if (typeof value === "number") return value;
	if (typeof value === "string") {
		const t = Date.parse(value);
		return Number.isFinite(t) ? t : null;
	}
	return null;
}

function startOfDay(ms: number): number {
	const d = new Date(ms);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

function isSameDay(a: number, b: number): boolean {
	return startOfDay(a) === startOfDay(b);
}

function weekStart(date: Date, weekStartOn: CalendarWeekStart): Date {
	const d = new Date(date);
	d.setHours(0, 0, 0, 0);
	const targetDow = weekStartOn === CalendarWeekStart.Sunday ? 0 : 1;
	const delta = (d.getDay() - targetDow + 7) % 7;
	d.setDate(d.getDate() - delta);
	return d;
}
