/**
 * Timeline view renderer — horizontal time axis with markers (events) and
 * bars (spans). Per ` §Timeline` and the
 * `deriveTimelineMode` semantics in `logic/timeline-mode.ts`.
 *
 * Scope: axis with day / month / quarter primary scales as a function of
 * `pxPerDay`; markers for events; bars for spans; optional swimlanes via
 * `swimlaneBy`; vertical "now" line; horizontal scroll. 9.12.10 added the
 * write-side interactions — bar drag-to-move, right-edge drag-to-resize
 * (whole-day snapped, committed via the host's `onMoveItem`/`onResizeItem`
 * entities.write hooks) — and the `dependencyLinkTypes` predecessor
 * arrows (one non-interactive SVG overlay).
 */

import { attachOrderedGridCellKeyboard } from "@brainstorm-os/sdk/a11y";
import { attachResizable } from "@brainstorm-os/sdk/resizable";
import { t } from "../i18n";
import { datePropertyCandidates } from "../logic/auto-group";
import type { CompiledView } from "../logic/compile-view";
import type { EntityRow } from "../logic/in-memory-entities";
import { readPropertyPath } from "../logic/in-memory-entities";
import { resolveVocabularyColor as vocabularyColor } from "../logic/property-resolver";
import { type DependencyLinkInput, dependencyEdges } from "../logic/timeline-deps";
import { dragDeltaDays, isDragMovement, movedDates, resizedEnd } from "../logic/timeline-drag";
import type { TimelineMetrics } from "../logic/timeline-metrics";
import { itemLabelVisible, timelineMetrics } from "../logic/timeline-metrics";
import { deriveTimelineMode } from "../logic/timeline-mode";
import type { TimelineLayoutOptions } from "../types/list-view";
import { TimelineMode } from "../types/list-view";
import { humanize } from "../ui/humanize";
import { entityIcon, entityTitle, formatDayLabel } from "./cells";

const DAY_MS = 24 * 60 * 60 * 1000;
const LABEL_WIDTH = 140;
const LABEL_WIDTH_MIN = 96;
const LABEL_WIDTH_MAX = 480;
const LABEL_WIDTH_STORAGE_KEY = "database:timeline-label-width";
const AXIS_HEIGHT = 56;
const PAD_X = 24;

export type TimelineViewProps = {
	compiled: CompiledView;
	layout: TimelineLayoutOptions;
	selectedIds: ReadonlySet<string>;
	onSelect: (entity: EntityRow, modifiers: { shiftKey: boolean; metaKey: boolean }) => void;
	onOpen: (entity: EntityRow) => void;
	/** 9.12.10 — drag a span bar along the axis: commit the whole-day-
	 *  shifted dates. Absent → bars don't move-drag (read-only host). */
	onMoveItem?: (entity: EntityRow, newStartMs: number, newEndMs: number | null) => void;
	/** 9.12.10 — drag a span bar's right edge: commit the resized end
	 *  (clamped ≥ start). Absent → no resize handle renders. */
	onResizeItem?: (entity: EntityRow, newEndMs: number) => void;
	/** 9.12.10 — the vault's link rows; arrows draw for links whose type is
	 *  in `layout.dependencyLinkTypes` when `layout.showDependencies`. */
	links?: ReadonlyArray<DependencyLinkInput>;
};

export function renderTimelineView(host: HTMLElement, props: TimelineViewProps): void {
	host.replaceChildren();
	host.classList.add("dbv-timeline");

	if (props.compiled.rows.length === 0) {
		const empty = document.createElement("div");
		empty.className = "dbv-empty";
		empty.textContent = "No items match this view.";
		host.appendChild(empty);
		return;
	}

	const items = props.compiled.rows
		.map((entity) => buildItem(entity, props.layout))
		.filter((item): item is TimelineItem => item !== null);
	if (items.length === 0) {
		const empty = document.createElement("div");
		empty.className = "dbv-empty";
		// Two distinct dead-ends (F-211): the bound property simply has no
		// values (→ point at the other date properties under View settings →
		// Dates), vs. the collection having no date property at all (→ say a
		// date column must exist first). The kind-switch auto-bind
		// (`bindTimelineDate`) makes the first case rare.
		const hasDateProperty = datePropertyCandidates(props.compiled.rows).length > 0;
		empty.textContent = hasDateProperty
			? t("brainstorm.database.timeline.emptyNoValues", {
					property: humanize(props.layout.primaryDateProperty),
				})
			: t("brainstorm.database.timeline.emptyNoDateProperty");
		host.appendChild(empty);
		return;
	}

	const mode = deriveTimelineMode({
		endDateProperty: props.layout.endDateProperty,
		members: items.map((i) => ({ hasEnd: i.end !== null })),
	});

	const swimlanes = groupSwimlanes(items, props.layout.swimlaneBy);
	const range = computeRange(items);
	const pxPerDay = clampPxPerDay(props.layout.pxPerDay);
	const metrics = timelineMetrics(props.layout.density);
	const rowStride = metrics.laneHeight + metrics.laneGap;

	const totalDays = Math.max(1, Math.ceil((range.end - range.start) / DAY_MS));
	const trackWidth = totalDays * pxPerDay + PAD_X * 2;
	const trackHeight = swimlanes.length * rowStride + AXIS_HEIGHT + 16;

	const stage = document.createElement("div");
	stage.className = "dbv-tl__stage";

	const labels = document.createElement("div");
	labels.className = "dbv-tl__labels";

	// Inner column is translated by the track's vertical scroll so the
	// gutter stays locked to its rows. `flex: none` on each cell (CSS) is
	// what keeps the explicit heights from being collapsed by the column
	// flexbox — without it 100+ labels shrink into illegible overlap.
	const labelsInner = document.createElement("div");
	labelsInner.className = "dbv-tl__labels-inner";

	const axisSpacer = document.createElement("div");
	axisSpacer.className = "dbv-tl__label-spacer";
	axisSpacer.style.height = `${AXIS_HEIGHT}px`;
	labelsInner.appendChild(axisSpacer);

	for (const lane of swimlanes) {
		const cell = document.createElement("div");
		cell.className = "dbv-tl__label";
		cell.style.height = `${rowStride}px`;
		cell.textContent = lane.label;
		cell.title = lane.label;
		labelsInner.appendChild(cell);
	}
	labels.appendChild(labelsInner);
	stage.appendChild(labels);

	const resizeHandle = document.createElement("div");
	resizeHandle.className = "dbv-tl__labels-resize";
	resizeHandle.setAttribute("role", "separator");
	resizeHandle.setAttribute("aria-orientation", "vertical");
	resizeHandle.tabIndex = 0;
	stage.appendChild(resizeHandle);
	attachResizable({
		handle: resizeHandle,
		side: "left",
		defaultWidth: LABEL_WIDTH,
		min: LABEL_WIDTH_MIN,
		max: LABEL_WIDTH_MAX,
		storageKey: LABEL_WIDTH_STORAGE_KEY,
		onWidth: (px) => {
			stage.style.setProperty("--dbv-tl-label-width", `${px}px`);
		},
	});

	const scroll = document.createElement("div");
	scroll.className = "dbv-tl__scroll";

	const track = document.createElement("div");
	track.className = "dbv-tl__track";
	track.style.width = `${trackWidth}px`;
	track.style.height = `${trackHeight}px`;

	// Weekend bands sit behind the axis + items (appended first). Only worth
	// drawing when days are wide enough to read as columns.
	if (props.layout.showWeekends && pxPerDay >= 10) {
		paintWeekends(track, range.start, totalDays, pxPerDay, trackHeight);
	}
	paintAxis(track, range.start, totalDays, pxPerDay);

	const showItemLabel = itemLabelVisible(props.layout.swimlaneBy);
	// KBN-A-database (12.4): collect the item bars in row order so they can be
	// driven as a single keyboard listbox (Up/Down between bars, Enter opens).
	const bars: HTMLElement[] = [];
	const barEntities: EntityRow[] = [];
	// Anchor geometry per item — feeds the dependency arrows (9.12.10).
	const anchors = new Map<string, ItemAnchor>();
	swimlanes.forEach((lane, laneIndex) => {
		const laneEl = document.createElement("div");
		laneEl.className = "dbv-tl__lane";
		laneEl.style.top = `${AXIS_HEIGHT + laneIndex * rowStride}px`;
		laneEl.style.height = `${rowStride}px`;
		track.appendChild(laneEl);

		for (const item of lane.items) {
			const bar = paintItem(
				item,
				laneIndex,
				range.start,
				pxPerDay,
				mode,
				props,
				metrics,
				showItemLabel,
			);
			track.appendChild(bar);
			bars.push(bar);
			barEntities.push(item.entity);
			anchors.set(item.entity.id, itemAnchor(item, laneIndex, range.start, pxPerDay, metrics));
		}
	});

	if (props.layout.showDependencies && props.links && props.links.length > 0) {
		const edges = dependencyEdges(
			new Set(anchors.keys()),
			props.links,
			props.layout.dependencyLinkTypes,
		);
		if (edges.length > 0) {
			track.appendChild(paintDependencies(edges, anchors, trackWidth, trackHeight));
		}
	}

	if (props.layout.showNow) {
		const nowX = PAD_X + ((Date.now() - range.start) / DAY_MS) * pxPerDay;
		if (nowX >= 0 && nowX <= trackWidth) {
			const line = document.createElement("div");
			line.className = "dbv-tl__now";
			line.style.left = `${nowX}px`;
			line.style.height = `${trackHeight - 4}px`;
			line.style.top = "4px";
			const tag = document.createElement("span");
			tag.className = "dbv-tl__now-tag";
			tag.textContent = "Now";
			line.appendChild(tag);
			track.appendChild(line);
		}
	}

	scroll.appendChild(track);
	stage.appendChild(scroll);
	host.appendChild(stage);

	// KBN-A-database (12.4): the bars become one keyboard listbox (columns = 1
	// → Up/Down step item-to-item), Enter opens the focused record. The scroll
	// container holds focus (aria-activedescendant); bars demote to one Tab
	// stop. Bars are real DOM buttons (not virtualized), so this is exercised
	// in jsdom — only horizontal-scroll-into-view needs the real shell.
	if (bars.length > 0) {
		attachOrderedGridCellKeyboard(scroll, bars, {
			columns: 1,
			onOpenCell: (_cell, index) => {
				const entity = barEntities[index];
				if (entity) props.onOpen(entity);
			},
		});
	}

	// Lock the label gutter to the canvas's vertical scroll. Transform —
	// not `scrollTop` on a second scroller — so the two panes can never
	// drift and we stay GPU-only (project convention: move via transform).
	let syncQueued = false;
	scroll.addEventListener("scroll", () => {
		if (syncQueued) return;
		syncQueued = true;
		requestAnimationFrame(() => {
			syncQueued = false;
			labelsInner.style.transform = `translateY(${-scroll.scrollTop}px)`;
		});
	});

	scrollToCenter(scroll, range, pxPerDay);
}

/** Shade Saturday/Sunday columns so the work-week rhythm is legible. Each
 *  band is a non-interactive div behind the items; only drawn at day-level
 *  zoom (gated by the caller). */
function paintWeekends(
	track: HTMLElement,
	start: number,
	totalDays: number,
	pxPerDay: number,
	trackHeight: number,
): void {
	for (let i = 0; i < totalDays; i += 1) {
		const day = new Date(start + i * DAY_MS).getDay();
		if (day !== 0 && day !== 6) continue;
		const band = document.createElement("div");
		band.className = "dbv-tl__weekend";
		band.style.left = `${PAD_X + i * pxPerDay}px`;
		band.style.width = `${pxPerDay}px`;
		band.style.top = `${AXIS_HEIGHT}px`;
		band.style.height = `${trackHeight - AXIS_HEIGHT}px`;
		track.appendChild(band);
	}
}

function paintAxis(track: HTMLElement, start: number, totalDays: number, pxPerDay: number): void {
	const primary = pickPrimaryScale(pxPerDay);
	const secondary = pickSecondaryScale(pxPerDay);

	const primaryRow = document.createElement("div");
	primaryRow.className = "dbv-tl__axis-row dbv-tl__axis-row--primary";
	primaryRow.style.height = `${AXIS_HEIGHT / 2}px`;

	const secondaryRow = document.createElement("div");
	secondaryRow.className = "dbv-tl__axis-row dbv-tl__axis-row--secondary";
	secondaryRow.style.top = `${AXIS_HEIGHT / 2}px`;
	secondaryRow.style.height = `${AXIS_HEIGHT / 2}px`;

	emitTicks(primaryRow, start, totalDays, pxPerDay, primary, "primary");
	emitTicks(secondaryRow, start, totalDays, pxPerDay, secondary, "secondary");

	track.appendChild(primaryRow);
	track.appendChild(secondaryRow);
}

enum TimelineScale {
	Hour = "hour",
	SixHour = "6hour",
	Day = "day",
	Week = "week",
	Month = "month",
	Quarter = "quarter",
	Year = "year",
}

function pickPrimaryScale(pxPerDay: number): TimelineScale {
	if (pxPerDay > 200) return TimelineScale.Day;
	if (pxPerDay > 30) return TimelineScale.Month;
	if (pxPerDay > 5) return TimelineScale.Quarter;
	return TimelineScale.Year;
}

/** A tick label needs ~30px to render an "hh AM/PM" or weekday string
 *  legibly. Picking a scale whose step × pxPerDay drops below that produces
 *  the digit-soup we saw at pxPerDay=220 with hourly ticks. */
function pickSecondaryScale(pxPerDay: number): TimelineScale {
	if (pxPerDay > 600) return TimelineScale.Hour;
	if (pxPerDay > 120) return TimelineScale.SixHour;
	if (pxPerDay > 30) return TimelineScale.Week;
	if (pxPerDay > 5) return TimelineScale.Month;
	return TimelineScale.Quarter;
}

function emitTicks(
	row: HTMLElement,
	start: number,
	totalDays: number,
	pxPerDay: number,
	scale: TimelineScale,
	tier: "primary" | "secondary",
): void {
	const endMs = start + totalDays * DAY_MS;
	const cursor = floorTo(start, scale);
	let current = cursor;
	while (current <= endMs) {
		const next = advanceBy(current, scale);
		const xStart = PAD_X + ((current - start) / DAY_MS) * pxPerDay;
		const xEnd = PAD_X + ((next - start) / DAY_MS) * pxPerDay;
		const width = Math.max(0, xEnd - xStart);
		// Skip ticks too narrow to render a legible label — keeps the
		// secondary row from collapsing into digit soup at boundary zoom
		// levels even if the scale ladder isn't perfectly tuned.
		if (width > 22) {
			const tick = document.createElement("div");
			tick.className = `dbv-tl__tick dbv-tl__tick--${tier}`;
			tick.style.left = `${xStart}px`;
			tick.style.width = `${width}px`;
			tick.textContent = formatTick(current, scale);
			row.appendChild(tick);
		}
		current = next;
	}
}

function floorTo(ms: number, scale: TimelineScale): number {
	const d = new Date(ms);
	d.setMinutes(0, 0, 0);
	if (scale === TimelineScale.Hour) return d.getTime();
	if (scale === TimelineScale.SixHour) {
		d.setHours(d.getHours() - (d.getHours() % 6));
		return d.getTime();
	}
	d.setHours(0);
	if (scale === TimelineScale.Day) return d.getTime();
	if (scale === TimelineScale.Week) {
		const dayOfWeek = (d.getDay() + 6) % 7; // monday-anchored
		d.setDate(d.getDate() - dayOfWeek);
		return d.getTime();
	}
	d.setDate(1);
	if (scale === TimelineScale.Month) return d.getTime();
	if (scale === TimelineScale.Quarter) {
		const month = d.getMonth();
		d.setMonth(month - (month % 3));
		return d.getTime();
	}
	d.setMonth(0);
	return d.getTime();
}

function advanceBy(ms: number, scale: TimelineScale): number {
	const d = new Date(ms);
	if (scale === TimelineScale.Hour) d.setHours(d.getHours() + 1);
	else if (scale === TimelineScale.SixHour) d.setHours(d.getHours() + 6);
	else if (scale === TimelineScale.Day) d.setDate(d.getDate() + 1);
	else if (scale === TimelineScale.Week) d.setDate(d.getDate() + 7);
	else if (scale === TimelineScale.Month) d.setMonth(d.getMonth() + 1);
	else if (scale === TimelineScale.Quarter) d.setMonth(d.getMonth() + 3);
	else d.setFullYear(d.getFullYear() + 1);
	return d.getTime();
}

function formatTick(ms: number, scale: TimelineScale): string {
	const d = new Date(ms);
	if (scale === TimelineScale.Hour || scale === TimelineScale.SixHour) {
		return d.toLocaleTimeString(undefined, { hour: "numeric" });
	}
	if (scale === TimelineScale.Day)
		return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
	if (scale === TimelineScale.Week) return `W${weekNumber(d)}`;
	if (scale === TimelineScale.Month)
		return d.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
	if (scale === TimelineScale.Quarter)
		return `Q${Math.floor(d.getMonth() / 3) + 1} '${String(d.getFullYear()).slice(-2)}`;
	return String(d.getFullYear());
}

function weekNumber(d: Date): number {
	const target = new Date(d.valueOf());
	const dayNumber = (d.getDay() + 6) % 7;
	target.setDate(target.getDate() - dayNumber + 3);
	const firstThursday = new Date(target.getFullYear(), 0, 4);
	return 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
}

type TimelineItem = {
	entity: EntityRow;
	start: number;
	end: number | null;
	swimlane: string;
};

function buildItem(entity: EntityRow, layout: TimelineLayoutOptions): TimelineItem | null {
	const startRaw = readPropertyPath(entity, layout.primaryDateProperty);
	const start = readMs(startRaw);
	if (start === null) return null;
	const endRaw = layout.endDateProperty ? readPropertyPath(entity, layout.endDateProperty) : null;
	const end = layout.endDateProperty ? readMs(endRaw) : null;
	const swimlaneRaw = layout.swimlaneBy ? readPropertyPath(entity, layout.swimlaneBy) : null;
	const swimlane =
		swimlaneRaw === null || swimlaneRaw === undefined || swimlaneRaw === ""
			? "—"
			: String(swimlaneRaw);
	return { entity, start, end, swimlane };
}

function readMs(value: unknown): number | null {
	if (typeof value === "number") return value;
	if (typeof value === "string") {
		const t = Date.parse(value);
		return Number.isFinite(t) ? t : null;
	}
	return null;
}

function groupSwimlanes(
	items: TimelineItem[],
	swimlaneBy: string | null,
): { label: string; items: TimelineItem[] }[] {
	if (!swimlaneBy) {
		// Classic Gantt: one row per task (a single shared lane stacks
		// every bar on one line — unreadable for 100+ items).
		return items.map((item) => ({ label: entityTitle(item.entity), items: [item] }));
	}
	const map = new Map<string, TimelineItem[]>();
	for (const item of items) {
		const bucket = map.get(item.swimlane);
		if (bucket) bucket.push(item);
		else map.set(item.swimlane, [item]);
	}
	return Array.from(map.entries()).map(([label, lane]) => ({ label, items: lane }));
}

function computeRange(items: TimelineItem[]): { start: number; end: number } {
	let min = Number.POSITIVE_INFINITY;
	let max = Number.NEGATIVE_INFINITY;
	for (const item of items) {
		if (item.start < min) min = item.start;
		const end = item.end ?? item.start;
		if (end > max) max = end;
	}
	// Fixed small pad on each side so items don't sit flush with the
	// edge. The prior `max(2 days, 10% of range)` formula scaled with the
	// data range — a year-long timeline ended up with ~36 days of trailing
	// empty scroll, which read as "broken / wasted space".
	const pad = 2 * DAY_MS;
	return { start: min - pad, end: max + pad };
}

function paintItem(
	item: TimelineItem,
	laneIndex: number,
	rangeStart: number,
	pxPerDay: number,
	mode: TimelineMode,
	props: TimelineViewProps,
	metrics: TimelineMetrics,
	showItemLabel: boolean,
): HTMLElement {
	const startX = PAD_X + ((item.start - rangeStart) / DAY_MS) * pxPerDay;
	const widthDays = item.end !== null ? Math.max(0.25, (item.end - item.start) / DAY_MS) : 0;
	const width = widthDays * pxPerDay;

	const useMarker = mode === TimelineMode.Event || item.end === null;
	const colorProp = props.layout.colorBy;
	const colorValue = colorProp ? item.entity.properties[colorProp] : null;
	const color =
		colorProp && typeof colorValue === "string" ? vocabularyColor(colorProp, colorValue) : null;

	const rowStride = metrics.laneHeight + metrics.laneGap;
	const top = AXIS_HEIGHT + laneIndex * rowStride + (rowStride - metrics.itemHeight) / 2;

	if (useMarker) {
		const marker = document.createElement("button");
		marker.type = "button";
		marker.className = "dbv-tl__marker";
		marker.dataset.entityId = item.entity.id;
		if (props.selectedIds.has(item.entity.id)) marker.dataset.selected = "true";
		marker.style.left = `${startX - 6}px`;
		marker.style.top = `${top}px`;
		marker.style.height = `${metrics.itemHeight}px`;
		if (color) {
			marker.style.setProperty("--dbv-tl-color", color);
		}
		const dot = document.createElement("span");
		dot.className = "dbv-tl__marker-dot";
		marker.appendChild(dot);
		const markerIconEl = entityIcon(item.entity, 12);
		if (markerIconEl) {
			const glyph = document.createElement("span");
			glyph.className = "dbv-tl__glyph";
			glyph.appendChild(markerIconEl);
			marker.appendChild(glyph);
		}
		if (showItemLabel) {
			const label = document.createElement("span");
			label.className = "dbv-tl__marker-label";
			label.textContent = readLabel(item, props.layout);
			marker.appendChild(label);
		}
		marker.title = `${readLabel(item, props.layout)} — ${formatDayLabel(item.start)}`;
		marker.addEventListener("click", (event) => {
			event.stopPropagation();
			props.onSelect(item.entity, {
				shiftKey: event.shiftKey,
				metaKey: event.metaKey || event.ctrlKey,
			});
		});
		marker.addEventListener("dblclick", (event) => {
			event.stopPropagation();
			props.onOpen(item.entity);
		});
		marker.draggable = true;
		marker.addEventListener("dragstart", (event) => {
			event.dataTransfer?.setData("application/x-brainstorm-entity", item.entity.id);
			if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
		});
		return marker;
	}

	const bar = document.createElement("button");
	bar.type = "button";
	bar.className = "dbv-tl__bar";
	bar.dataset.entityId = item.entity.id;
	if (props.selectedIds.has(item.entity.id)) bar.dataset.selected = "true";
	bar.style.left = `${startX}px`;
	bar.style.top = `${top}px`;
	bar.style.width = `${Math.max(8, width)}px`;
	bar.style.height = `${metrics.itemHeight}px`;
	if (color) {
		bar.style.background = `color-mix(in srgb, ${color} 22%, transparent)`;
		bar.style.color = color;
		bar.style.borderColor = `color-mix(in srgb, ${color} 42%, transparent)`;
	}
	const barIconEl = entityIcon(item.entity, 12);
	if (barIconEl) {
		const barGlyph = document.createElement("span");
		barGlyph.className = "dbv-tl__glyph";
		barGlyph.appendChild(barIconEl);
		bar.appendChild(barGlyph);
	}
	if (showItemLabel) {
		const barLabel = document.createElement("span");
		barLabel.className = "dbv-tl__bar-label";
		barLabel.textContent = readLabel(item, props.layout);
		bar.appendChild(barLabel);
	}
	bar.title = `${readLabel(item, props.layout)} — ${formatDayLabel(item.start)} → ${
		item.end !== null ? formatDayLabel(item.end) : "?"
	}`;
	bar.addEventListener("click", (event) => {
		event.stopPropagation();
		// A completed drag fires a synthetic click on release — swallow it so
		// moving a bar doesn't also toggle the selection.
		if (bar.dataset.suppressClick === "true") {
			delete bar.dataset.suppressClick;
			return;
		}
		props.onSelect(item.entity, {
			shiftKey: event.shiftKey,
			metaKey: event.metaKey || event.ctrlKey,
		});
	});
	bar.addEventListener("dblclick", (event) => {
		event.stopPropagation();
		props.onOpen(item.entity);
	});
	if (item.end !== null && props.onResizeItem) {
		bar.appendChild(buildResizeHandle(bar, item as TimelineItem & { end: number }, pxPerDay, props));
	}
	if (props.onMoveItem) attachBarMoveDrag(bar, item, pxPerDay, props);
	return bar;
}

/** 9.12.10 — pointer drag on a span bar moves it along the date axis in
 *  whole-day steps (snapped live via transform, committed on release).
 *  Pointer events (not HTML5 DnD) so the bar tracks the cursor 1:1 and a
 *  sub-threshold press still reads as a click. */
function attachBarMoveDrag(
	bar: HTMLElement,
	item: TimelineItem,
	pxPerDay: number,
	props: TimelineViewProps,
): void {
	let originX = 0;
	let dragging = false;
	let moved = false;
	bar.addEventListener("pointerdown", (event: PointerEvent) => {
		if (event.button !== 0) return;
		if ((event.target as HTMLElement | null)?.closest(".dbv-tl__resize")) return;
		dragging = true;
		moved = false;
		originX = event.clientX;
		try {
			bar.setPointerCapture(event.pointerId);
		} catch {
			// jsdom / older engines — drag still works while the cursor stays
			// over the bar; capture is an enhancement, not a requirement.
		}
	});
	bar.addEventListener("pointermove", (event: PointerEvent) => {
		if (!dragging) return;
		const dx = event.clientX - originX;
		if (!moved && !isDragMovement(dx)) return;
		moved = true;
		bar.dataset.dragging = "true";
		bar.style.transform = `translateX(${dragDeltaDays(dx, pxPerDay) * pxPerDay}px)`;
	});
	const finish = (event: PointerEvent): void => {
		if (!dragging) return;
		dragging = false;
		bar.style.transform = "";
		delete bar.dataset.dragging;
		if (!moved) return;
		bar.dataset.suppressClick = "true";
		const days = dragDeltaDays(event.clientX - originX, pxPerDay);
		if (days !== 0) {
			const next = movedDates(item, days);
			props.onMoveItem?.(item.entity, next.start, next.end);
		}
	};
	bar.addEventListener("pointerup", finish);
	bar.addEventListener("pointercancel", () => {
		dragging = false;
		bar.style.transform = "";
		delete bar.dataset.dragging;
	});
}

/** 9.12.10 — right-edge handle resizes the span end in whole-day steps;
 *  the live width preview snaps to the day grid and the commit clamps so
 *  the span never inverts. */
function buildResizeHandle(
	bar: HTMLElement,
	item: TimelineItem & { end: number },
	pxPerDay: number,
	props: TimelineViewProps,
): HTMLElement {
	const handle = document.createElement("span");
	handle.className = "dbv-tl__resize";
	handle.setAttribute("aria-hidden", "true");
	const baseWidthDays = Math.max(0.25, (item.end - item.start) / DAY_MS);
	let originX = 0;
	let dragging = false;
	let moved = false;
	handle.addEventListener("pointerdown", (event: PointerEvent) => {
		if (event.button !== 0) return;
		event.stopPropagation();
		dragging = true;
		moved = false;
		originX = event.clientX;
		try {
			handle.setPointerCapture(event.pointerId);
		} catch {
			// see attachBarMoveDrag — capture is best-effort.
		}
	});
	handle.addEventListener("pointermove", (event: PointerEvent) => {
		if (!dragging) return;
		const dx = event.clientX - originX;
		if (!moved && !isDragMovement(dx)) return;
		moved = true;
		bar.dataset.dragging = "true";
		const days = dragDeltaDays(dx, pxPerDay);
		const nextEnd = resizedEnd(item.start, item.end, days);
		const widthDays = Math.max(0.25, (nextEnd - item.start) / DAY_MS);
		bar.style.width = `${Math.max(8, widthDays * pxPerDay)}px`;
	});
	const finish = (event: PointerEvent): void => {
		if (!dragging) return;
		dragging = false;
		delete bar.dataset.dragging;
		if (!moved) return;
		bar.dataset.suppressClick = "true";
		bar.style.width = `${Math.max(8, baseWidthDays * pxPerDay)}px`;
		const days = dragDeltaDays(event.clientX - originX, pxPerDay);
		if (days !== 0) props.onResizeItem?.(item.entity, resizedEnd(item.start, item.end, days));
	};
	handle.addEventListener("pointerup", finish);
	handle.addEventListener("pointercancel", () => {
		dragging = false;
		delete bar.dataset.dragging;
		bar.style.width = `${Math.max(8, baseWidthDays * pxPerDay)}px`;
	});
	return handle;
}

type ItemAnchor = { startX: number; endX: number; cy: number };

/** The geometry the dependency arrows need: the item's left/right edges
 *  and vertical centre — computed exactly as `paintItem` positions the
 *  bar/marker so arrows land flush on the visuals. */
function itemAnchor(
	item: TimelineItem,
	laneIndex: number,
	rangeStart: number,
	pxPerDay: number,
	metrics: TimelineMetrics,
): ItemAnchor {
	const startX = PAD_X + ((item.start - rangeStart) / DAY_MS) * pxPerDay;
	const widthDays = item.end !== null ? Math.max(0.25, (item.end - item.start) / DAY_MS) : 0;
	const endX = item.end !== null ? startX + Math.max(8, widthDays * pxPerDay) : startX;
	const rowStride = metrics.laneHeight + metrics.laneGap;
	const cy =
		AXIS_HEIGHT +
		laneIndex * rowStride +
		(rowStride - metrics.itemHeight) / 2 +
		metrics.itemHeight / 2;
	return { startX, endX, cy };
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** 9.12.10 — predecessor arrows as one non-interactive SVG overlay: a
 *  cubic from the predecessor's right edge to the successor's left edge
 *  with a small arrowhead. Drawn above lanes, below nothing interactive
 *  (`pointer-events: none` in CSS). */
function paintDependencies(
	edges: ReadonlyArray<{ fromId: string; toId: string }>,
	anchors: ReadonlyMap<string, ItemAnchor>,
	width: number,
	height: number,
): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, "svg");
	svg.setAttribute("class", "dbv-tl__deps");
	svg.setAttribute("width", String(width));
	svg.setAttribute("height", String(height));
	svg.setAttribute("aria-hidden", "true");

	const defs = document.createElementNS(SVG_NS, "defs");
	const marker = document.createElementNS(SVG_NS, "marker");
	marker.setAttribute("id", "dbv-tl-arrow");
	marker.setAttribute("viewBox", "0 0 8 8");
	marker.setAttribute("refX", "7");
	marker.setAttribute("refY", "4");
	marker.setAttribute("markerWidth", "7");
	marker.setAttribute("markerHeight", "7");
	marker.setAttribute("orient", "auto-start-reverse");
	const tip = document.createElementNS(SVG_NS, "path");
	tip.setAttribute("d", "M0,0 L8,4 L0,8 Z");
	tip.setAttribute("fill", "currentColor");
	marker.appendChild(tip);
	defs.appendChild(marker);
	svg.appendChild(defs);

	for (const edge of edges) {
		const from = anchors.get(edge.fromId);
		const to = anchors.get(edge.toId);
		if (!from || !to) continue;
		const x1 = from.endX + 2;
		const y1 = from.cy;
		const x2 = to.startX - 3;
		const y2 = to.cy;
		const bend = Math.max(16, Math.min(48, Math.abs(x2 - x1) / 2));
		const path = document.createElementNS(SVG_NS, "path");
		path.setAttribute("class", "dbv-tl__dep");
		path.setAttribute("d", `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`);
		path.setAttribute("fill", "none");
		path.setAttribute("marker-end", "url(#dbv-tl-arrow)");
		svg.appendChild(path);
	}
	return svg;
}

function readLabel(item: TimelineItem, layout: TimelineLayoutOptions): string {
	if (layout.labelProperty) {
		const v = readPropertyPath(item.entity, layout.labelProperty);
		if (typeof v === "string" && v) return v;
	}
	return entityTitle(item.entity);
}

function clampPxPerDay(v: number): number {
	if (!Number.isFinite(v)) return 32;
	if (v < 0.5) return 0.5;
	if (v > 600) return 600;
	return v;
}

/** Scroll the timeline so the first item is comfortably visible. Without
 *  this the user lands on the leading padding and has to scrub right to
 *  see anything — non-obvious for a horizontal view. Anchored after the
 *  layout commits via a microtask so `scrollWidth` is accurate. */
function scrollToCenter(
	scroll: HTMLElement,
	range: { start: number; end: number },
	pxPerDay: number,
): void {
	queueMicrotask(() => {
		const focus = Date.now();
		const x = PAD_X + ((focus - range.start) / DAY_MS) * pxPerDay;
		const target = Math.max(0, x - scroll.clientWidth / 3);
		scroll.scrollLeft = Math.min(target, scroll.scrollWidth - scroll.clientWidth);
	});
}
