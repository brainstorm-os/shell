/**
 * Timeline / Gantt view (9.14.11) — paints the `compileGantt` model as one
 * lane per task: a horizontal day axis, a day-quantized bar per task, an
 * SVG overlay drawing dependency edges (predecessor bar-end → successor
 * bar-start), and a today line. All geometry derives from the model's
 * `rangeDays` index (never DOM measurement), so the math is testable and
 * exact across DST.
 *
 * A header toolbar offers a density control (Days / Weeks / Months — the
 * `pxPerDay` zoom) and a "Today" jump; weekend columns are shaded and each
 * month boundary draws a full-height separator so a long range stays
 * legible. The toolbar + zoom are wired only when the host passes
 * `onSetZoom` (preview mode omits it).
 *
 * KBN-A (12.4): the lane bars form a `columns: 1` listbox via the shared
 * `attachOrderedGridCellKeyboard` — Up/Down move between bars, Enter opens
 * the focused task — mirroring the Database timeline rung (the container
 * is the single Tab stop; `aria-activedescendant` tracks the active bar).
 */

import { attachOrderedGridCellKeyboard } from "@brainstorm-os/sdk/a11y";
import { IconName, createIconElement } from "@brainstorm-os/sdk/icon";
import { openAnchoredMenu } from "@brainstorm-os/sdk/object-menu";
import { t, tCount } from "../i18n/t";
import { type GanttModel, type GanttRow, rangeDays } from "../logic/gantt";
import { formatMinutes } from "../logic/task-time";
import type { Task } from "../types/task";
import { formatDateRelative } from "./format-date";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Geometry constants — exported for the view test, which asserts bar
 *  positions against the same numbers instead of magic literals. `pxPerDay`
 *  is the default density (the `Weeks` zoom); the active zoom overrides it. */
export const TIMELINE_METRICS = {
	pxPerDay: 28,
	laneHeight: 36,
	barHeight: 24,
	axisHeight: 44,
} as const;

/** Horizontal density — the day-column width. `Weeks` matches the default
 *  `TIMELINE_METRICS.pxPerDay`, so an un-zoomed timeline is byte-identical. */
export enum TimelineZoom {
	Days = "days",
	Weeks = "weeks",
	Months = "months",
}

export const TIMELINE_ZOOMS: readonly TimelineZoom[] = Object.freeze([
	TimelineZoom.Days,
	TimelineZoom.Weeks,
	TimelineZoom.Months,
]);

const ZOOM_PX: Record<TimelineZoom, number> = {
	[TimelineZoom.Days]: 48,
	[TimelineZoom.Weeks]: TIMELINE_METRICS.pxPerDay,
	[TimelineZoom.Months]: 12,
};

const ZOOM_LABEL_KEY: Record<TimelineZoom, string> = {
	[TimelineZoom.Days]: "tasks.timeline.zoom.days",
	[TimelineZoom.Weeks]: "tasks.timeline.zoom.weeks",
	[TimelineZoom.Months]: "tasks.timeline.zoom.months",
};

/** Trailing glyph marking the active density row. */
const SELECTED_MARK = "✓";

/** Below this rendered width a bar can't fit even a short name inside the
 *  pill, so its label is moved out to the right of the bar. */
const COMPACT_BAR_PX = 72;

export type TimelineViewProps = {
	model: GanttModel;
	now: number;
	/** The task whose bar the keyboard cursor starts on (mirrors the list). */
	selectedTaskId?: string | null;
	/** Active horizontal density. Defaults to `Weeks` (the un-zoomed width). */
	zoom?: TimelineZoom;
	/** Wired by the host to persist a density change; its presence is what
	 *  surfaces the toolbar (preview mode omits it). */
	onSetZoom?(zoom: TimelineZoom): void;
	/** Bar clicked — select it (same as a row click → inspector). */
	onSelectTask?(task: Task): void;
	/** Enter on the focused bar / double-click — open the task for editing. */
	onOpenEdit?(task: Task): void;
};

export function renderTimelineView(props: TimelineViewProps): HTMLElement {
	const root = document.createElement("div");
	root.className = "tasks-timeline";
	root.setAttribute("aria-label", t("tasks.timeline.region"));

	if (props.model.rows.length === 0) {
		const empty = document.createElement("div");
		empty.className = "tasks-timeline__empty";
		empty.appendChild(createIconElement(IconName.KindDate, { size: 28 }));
		const copy = document.createElement("p");
		copy.className = "tasks-timeline__empty-copy";
		copy.textContent = t("tasks.timeline.empty");
		empty.appendChild(copy);
		root.appendChild(empty);
		appendUnscheduledNote(root, props.model.unscheduledCount);
		return root;
	}

	const pxPerDay = ZOOM_PX[props.zoom ?? TimelineZoom.Weeks];
	const days = rangeDays(props.model);
	const dayIndex = new Map<number, number>();
	days.forEach((d, i) => dayIndex.set(d, i));
	const { laneHeight, axisHeight } = TIMELINE_METRICS;
	const width = days.length * pxPerDay;
	const height = axisHeight + props.model.rows.length * laneHeight;

	const scroll = document.createElement("div");
	scroll.className = "tasks-timeline__scroll";
	const stage = document.createElement("div");
	stage.className = "tasks-timeline__stage";
	stage.style.width = `${width}px`;
	stage.style.height = `${height}px`;

	stage.appendChild(renderGrid(days, pxPerDay, axisHeight, height));
	stage.appendChild(renderAxis(days, props.now, pxPerDay));
	stage.appendChild(renderEdges(props.model, dayIndex, width, height, pxPerDay));

	const bars: HTMLElement[] = [];
	props.model.rows.forEach((row, lane) => {
		const bar = renderBar(row, lane, dayIndex, pxPerDay, props);
		bars.push(bar);
		stage.appendChild(bar);
	});

	const todayIdx = dayIndex.get(dayOf(days, props.now));
	if (todayIdx !== undefined) {
		const today = document.createElement("div");
		today.className = "tasks-timeline__today";
		today.style.left = `${(todayIdx + 0.5) * pxPerDay}px`;
		stage.appendChild(today);
	}

	scroll.appendChild(stage);

	const scrollToToday = () => {
		if (todayIdx === undefined) return;
		const target = Math.max(0, (todayIdx + 0.5) * pxPerDay - scroll.clientWidth / 2);
		scroll.scrollLeft = target;
	};

	if (props.onSetZoom) {
		root.appendChild(renderToolbar(props.zoom ?? TimelineZoom.Weeks, props.onSetZoom, scrollToToday));
	}

	root.appendChild(scroll);
	appendUnscheduledNote(root, props.model.unscheduledCount);

	// Centre on today after the element mounts (scrollLeft needs a laid-out
	// clientWidth). rAF is absent under the jsdom test env — guarded.
	if (todayIdx !== undefined && typeof requestAnimationFrame === "function") {
		requestAnimationFrame(scrollToToday);
	}

	const onOpenEdit = props.onOpenEdit;
	if (onOpenEdit) {
		const initial = props.model.rows.findIndex((r) => r.task.id === props.selectedTaskId);
		attachOrderedGridCellKeyboard(scroll, bars, {
			columns: 1,
			onOpenCell: (_cell, index) => {
				const row = props.model.rows[index];
				if (row) onOpenEdit(row.task);
			},
			...(initial >= 0 ? { initialIndex: initial } : {}),
		});
	}
	return root;
}

/** The density picker + "Today" jump. The picker reuses the shared toggle
 *  chrome (leading glyph + label) and opens the anchored menu listing the
 *  three densities, the active one marked. */
function renderToolbar(
	zoom: TimelineZoom,
	onSetZoom: (zoom: TimelineZoom) => void,
	onJumpToday: () => void,
): HTMLElement {
	const bar = document.createElement("div");
	bar.className = "tasks-timeline__toolbar";

	const today = document.createElement("button");
	today.type = "button";
	today.className = "tasks-surface__toggle tasks-surface__toggle--icon";
	today.appendChild(createIconElement(IconName.KindDate, { size: 14 }));
	const todayLabel = document.createElement("span");
	todayLabel.textContent = t("tasks.timeline.today");
	today.appendChild(todayLabel);
	today.setAttribute("aria-label", t("tasks.timeline.today.scroll"));
	today.addEventListener("click", onJumpToday);
	bar.appendChild(today);

	const density = document.createElement("button");
	density.type = "button";
	density.className = "tasks-surface__toggle tasks-surface__toggle--icon";
	density.appendChild(createIconElement(IconName.View, { size: 14 }));
	const label = document.createElement("span");
	label.textContent = t("tasks.timeline.zoom.label", { level: t(ZOOM_LABEL_KEY[zoom]) });
	density.appendChild(label);
	density.addEventListener("click", () => {
		const rect = density.getBoundingClientRect();
		openAnchoredMenu(
			{ x: rect.left, y: rect.bottom + 4 },
			TIMELINE_ZOOMS.map((level) => ({
				label: t(ZOOM_LABEL_KEY[level]),
				...(level === zoom ? { shortcut: SELECTED_MARK } : {}),
				onSelect: () => onSetZoom(level),
			})),
			{ menuLabel: t("tasks.timeline.zoom.menuLabel"), anchor: density },
		);
	});
	bar.appendChild(density);

	return bar;
}

/** The day-start in `days` containing `ms` (binary-search-free: the range
 *  is small and the renderer runs once per paint). */
function dayOf(days: readonly number[], ms: number): number {
	let found = days[0] ?? 0;
	for (const d of days) {
		if (d <= ms) found = d;
		else break;
	}
	return found;
}

/** The structural under-layer: a shaded column behind every weekend day and
 *  a full-height separator at each month boundary. Both derive from the day
 *  index, so they stay aligned with the axis at any density. */
function renderGrid(
	days: readonly number[],
	pxPerDay: number,
	axisHeight: number,
	height: number,
): HTMLElement {
	const grid = document.createElement("div");
	grid.className = "tasks-timeline__grid";
	grid.setAttribute("aria-hidden", "true");
	let lastMonth = -1;
	days.forEach((dayMs, i) => {
		const date = new Date(dayMs);
		const weekday = date.getDay();
		if (weekday === 0 || weekday === 6) {
			const col = document.createElement("div");
			col.className = "tasks-timeline__weekend";
			col.style.left = `${i * pxPerDay}px`;
			col.style.width = `${pxPerDay}px`;
			col.style.top = `${axisHeight}px`;
			col.style.height = `${height - axisHeight}px`;
			grid.appendChild(col);
		}
		const month = date.getMonth();
		if (month !== lastMonth) {
			lastMonth = month;
			if (i > 0) {
				const sep = document.createElement("div");
				sep.className = "tasks-timeline__month-sep";
				sep.style.left = `${i * pxPerDay}px`;
				sep.style.top = `${axisHeight}px`;
				sep.style.height = `${height - axisHeight}px`;
				grid.appendChild(sep);
			}
		}
	});
	return grid;
}

function renderAxis(days: readonly number[], now: number, pxPerDay: number): HTMLElement {
	const { axisHeight } = TIMELINE_METRICS;
	const axis = document.createElement("div");
	axis.className = "tasks-timeline__axis";
	axis.style.height = `${axisHeight}px`;
	axis.setAttribute("aria-hidden", "true");
	let lastMonth = -1;
	days.forEach((dayMs, i) => {
		const date = new Date(dayMs);
		const cell = document.createElement("div");
		cell.className = "tasks-timeline__axis-day";
		cell.style.left = `${i * pxPerDay}px`;
		cell.style.width = `${pxPerDay}px`;
		const weekday = date.getDay();
		if (weekday === 0 || weekday === 6) cell.dataset.weekend = "true";
		const today = new Date(now);
		if (
			date.getFullYear() === today.getFullYear() &&
			date.getMonth() === today.getMonth() &&
			date.getDate() === today.getDate()
		) {
			cell.dataset.today = "true";
		}
		cell.textContent = String(date.getDate());
		if (date.getMonth() !== lastMonth) {
			lastMonth = date.getMonth();
			const month = document.createElement("span");
			month.className = "tasks-timeline__axis-month";
			month.textContent = date.toLocaleDateString(undefined, {
				month: "short",
				...(date.getMonth() === 0 || i === 0 ? { year: "numeric" } : {}),
			});
			cell.appendChild(month);
		}
		axis.appendChild(cell);
	});
	return axis;
}

function renderBar(
	row: GanttRow,
	lane: number,
	dayIndex: ReadonlyMap<number, number>,
	pxPerDay: number,
	props: TimelineViewProps,
): HTMLElement {
	const { laneHeight, barHeight, axisHeight } = TIMELINE_METRICS;
	const startIdx = dayIndex.get(row.span.startMs) ?? 0;
	const endIdx = dayIndex.get(row.span.endMs) ?? dayIndex.size;

	const bar = document.createElement("button");
	bar.type = "button";
	bar.className = "tasks-timeline__bar";
	// Deliberately NOT `data-task-id`: the targeted-row-update machinery
	// patches `[data-task-id]` nodes in place as LIST ROWS — a bar matching
	// that selector would be swapped for an unpositioned row element.
	bar.dataset.ganttTaskId = row.task.id;
	const widthPx = Math.max(1, endIdx - startIdx) * pxPerDay;
	bar.style.left = `${startIdx * pxPerDay}px`;
	bar.style.width = `${widthPx}px`;
	bar.style.top = `${axisHeight + lane * laneHeight + (laneHeight - barHeight) / 2}px`;
	bar.style.height = `${barHeight}px`;
	// A short bar can't hold its name inside the pill; flag it so the label
	// renders out to the right in the open lane instead of clipping to "1.".
	if (widthPx < COMPACT_BAR_PX) bar.classList.add("tasks-timeline__bar--compact");

	const task = row.task;
	const done = task.completedAt !== null;
	const overdue = !done && task.dueAt !== null && task.dueAt < props.now;
	if (done) bar.dataset.state = "done";
	else if (overdue) bar.dataset.state = "overdue";
	if (row.blocked && !done) bar.dataset.blocked = "true";
	if (row.span.derivedStart) bar.dataset.derivedStart = "true";

	const label = document.createElement("span");
	label.className = "tasks-timeline__bar-label";
	label.textContent = task.name;
	bar.appendChild(label);

	const estimate = formatMinutes(task.estimateMinutes ?? null);
	const ariaDates = t("tasks.timeline.bar.dates", {
		start: formatDateRelative(row.span.startMs, props.now),
		end: formatDateRelative(row.span.endMs - 1, props.now),
	});
	bar.title = estimate.length > 0 ? `${task.name} · ${estimate}` : task.name;
	bar.setAttribute("aria-label", `${task.name}, ${ariaDates}`);

	const onSelectTask = props.onSelectTask;
	if (onSelectTask) bar.addEventListener("click", () => onSelectTask(task));
	const onOpenEdit = props.onOpenEdit;
	if (onOpenEdit) bar.addEventListener("dblclick", () => onOpenEdit(task));
	return bar;
}

/** Dependency edges as one SVG overlay. Elbow per edge: out of the
 *  predecessor's bar-end, vertically to the successor's lane, into its
 *  bar-start; an edge whose target starts left of its source routes the
 *  long way round (still readable, just back-tracking). */
function renderEdges(
	model: GanttModel,
	dayIndex: ReadonlyMap<number, number>,
	width: number,
	height: number,
	pxPerDay: number,
): SVGSVGElement {
	const { laneHeight, axisHeight } = TIMELINE_METRICS;
	const svg = document.createElementNS(SVG_NS, "svg");
	svg.setAttribute("class", "tasks-timeline__edges");
	svg.setAttribute("width", String(width));
	svg.setAttribute("height", String(height));
	svg.setAttribute("aria-hidden", "true");

	const defs = document.createElementNS(SVG_NS, "defs");
	const marker = document.createElementNS(SVG_NS, "marker");
	marker.setAttribute("id", "tasks-timeline-arrow");
	marker.setAttribute("viewBox", "0 0 8 8");
	marker.setAttribute("refX", "7");
	marker.setAttribute("refY", "4");
	marker.setAttribute("markerWidth", "8");
	marker.setAttribute("markerHeight", "8");
	marker.setAttribute("orient", "auto");
	const tip = document.createElementNS(SVG_NS, "path");
	tip.setAttribute("d", "M0,0L8,4L0,8Z");
	tip.setAttribute("fill", "currentColor");
	marker.appendChild(tip);
	defs.appendChild(marker);
	svg.appendChild(defs);

	const laneY = (lane: number) => axisHeight + lane * laneHeight + laneHeight / 2;
	for (const edge of model.edges) {
		const from = model.rows[edge.fromIndex];
		const to = model.rows[edge.toIndex];
		if (!from || !to) continue;
		const x1 = (dayIndex.get(from.span.endMs) ?? 0) * pxPerDay;
		const y1 = laneY(edge.fromIndex);
		const x2 = (dayIndex.get(to.span.startMs) ?? 0) * pxPerDay;
		const y2 = laneY(edge.toIndex);
		const path = document.createElementNS(SVG_NS, "path");
		const stub = pxPerDay / 4;
		const d =
			x2 >= x1 + stub * 2
				? `M${x1},${y1} H${x1 + stub} V${y2} H${x2}`
				: `M${x1},${y1} h${stub} V${(y1 + y2) / 2} H${x2 - stub} V${y2} H${x2}`;
		path.setAttribute("d", d);
		path.setAttribute("class", "tasks-timeline__edge");
		path.setAttribute("fill", "none");
		path.setAttribute("stroke", "currentColor");
		path.setAttribute("marker-end", "url(#tasks-timeline-arrow)");
		svg.appendChild(path);
	}
	return svg;
}

function appendUnscheduledNote(root: HTMLElement, count: number): void {
	if (count <= 0) return;
	const note = document.createElement("div");
	note.className = "tasks-timeline__unscheduled";
	note.textContent = tCount("tasks.timeline.unscheduled", count);
	root.appendChild(note);
}
