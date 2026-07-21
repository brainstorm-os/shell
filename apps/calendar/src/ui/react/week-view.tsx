/**
 * Week / Day view (React) — 7 (or 1) columns with a 24-hour gutter. Timed
 * blocks are absolutely positioned via inline `top`/`height` from each
 * event's start + duration; all-day items pin to a header band; each hour is
 * a clickable slot that composes an event at that instant. After mount the
 * grid scrolls to the working hour; the now-line marks the current minute on
 * today's column. Drag-to-reschedule + ordered grid keyboard preserved.
 */

import { attachOrderedGridCellKeyboard } from "@brainstorm-os/sdk/a11y";
import { useEffect, useRef } from "react";
import { t } from "../../i18n/t";
import type { CompiledDayView, CompiledWeekView, WeekDayBucket } from "../../logic/compile-view";
import type { ScheduledItem } from "../../logic/scheduled-item";
import { EventChip } from "./event-chip";
import { beginBlockDrag } from "./use-chip-drag";
import type { ViewCallbacks } from "./view-callbacks";

const HOUR_HEIGHT_PX = 64;
const TOTAL_HOURS = 24;
const SCROLL_TO_HOUR = 7;

export type WeekViewProps = {
	compiled: CompiledWeekView | CompiledDayView;
	now: number;
	callbacks: Pick<ViewCallbacks, "onItemClick" | "onEmptyCellClick" | "objectMenu" | "onReschedule">;
};

function formatHour(hour: number): string {
	return new Date(2000, 0, 1, hour, 0, 0, 0).toLocaleTimeString(undefined, { hour: "numeric" });
}

function minutesIntoDay(epochMs: number): number {
	const d = new Date(epochMs);
	return d.getHours() * 60 + d.getMinutes();
}

function minutesIntoDayFromEpoch(epochMs: number, dayStart: number): number {
	return Math.floor(Math.max(0, epochMs - dayStart) / 60_000);
}

function clampToDay(mins: number): number {
	if (mins < 0) return 0;
	if (mins > TOTAL_HOURS * 60) return TOTAL_HOURS * 60;
	return mins;
}

export function WeekView({ compiled, now, callbacks }: WeekViewProps) {
	const days: WeekDayBucket[] = "days" in compiled ? [...compiled.days] : [compiled.day];
	const { onItemClick, onEmptyCellClick, objectMenu, onReschedule } = callbacks;

	const gridRef = useRef<HTMLDivElement>(null);

	// Open on the working hour rather than midnight; the grid has scroll height
	// only after layout, so do it post-mount.
	useEffect(() => {
		const grid = gridRef.current;
		if (grid) grid.scrollTop = Math.max(0, SCROLL_TO_HOUR * HOUR_HEIGHT_PX - 12);
	}, []);

	// KBN-A-calendar: the hour slots form a days × hours grid; the DOM is
	// column-major so collect slots row-major (hour h across every day) and
	// attach the ordered grid binding. `compiled` re-attaches after a rerender.
	// biome-ignore lint/correctness/useExhaustiveDependencies: compiled triggers re-attach after rerender
	useEffect(() => {
		const grid = gridRef.current;
		if (!grid) return;
		const ordered: HTMLButtonElement[] = [];
		for (let h = 0; h < TOTAL_HOURS; h++) {
			for (let d = 0; d < days.length; d++) {
				const slot = grid.querySelector<HTMLButtonElement>(
					`.cal-week__column[data-day-index="${d}"] .cal-week__slot[data-hour="${h}"]`,
				);
				if (slot) ordered.push(slot);
			}
		}
		if (ordered.length === 0) return;
		const startHour = Math.min(SCROLL_TO_HOUR, TOTAL_HOURS - 1);
		const handle = attachOrderedGridCellKeyboard(grid, ordered, {
			columns: Math.max(1, days.length),
			initialIndex: startHour * days.length,
			onOpenCell: (cell) => {
				const startMs = Number(cell.dataset.slotStartMs);
				if (Number.isFinite(startMs)) onEmptyCellClick(startMs);
			},
		});
		return () => handle.destroy();
	}, [days.length, onEmptyCellClick, compiled]);

	return (
		<section className="cal-week" data-kind={compiled.kind}>
			<header className="cal-week__head">
				<span className="cal-week__gutter" aria-hidden="true" />
				{days.map((day) => {
					const date = new Date(day.dayStart);
					const cls = [
						"cal-week__head-cell",
						day.isToday ? "cal-week__head-cell--today" : "",
						day.isWeekend ? "cal-week__head-cell--weekend" : "",
					]
						.filter(Boolean)
						.join(" ");
					return (
						<button type="button" key={day.dateKey} className={cls}>
							<span className="cal-week__head-dow">
								{date.toLocaleDateString(undefined, { weekday: "short" })}
							</span>
							<span className="cal-week__head-num">{date.getDate()}</span>
						</button>
					);
				})}
			</header>

			<div className="cal-week__allday">
				<span className="cal-week__gutter cal-week__gutter--allday">{t("calendar.event.allDay")}</span>
				{days.map((day) => (
					<div
						key={day.dateKey}
						className={`cal-week__allday-cell${day.isWeekend ? " cal-week__allday-cell--weekend" : ""}`}
					>
						{day.allDayItems.map((item) => (
							<EventChip
								key={item.id}
								item={item}
								mode="compact"
								onClick={onItemClick}
								objectMenu={objectMenu}
							/>
						))}
					</div>
				))}
			</div>

			<div
				className="cal-week__grid"
				ref={gridRef}
				style={{
					["--hour-height" as string]: `${HOUR_HEIGHT_PX}px`,
					["--hour-count" as string]: String(TOTAL_HOURS),
				}}
			>
				<div className="cal-week__hour-gutter">
					{Array.from({ length: TOTAL_HOURS }, (_, h) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: fixed 24-hour positional gutter
						<span key={h} className="cal-week__hour-label" style={{ top: `${h * HOUR_HEIGHT_PX}px` }}>
							{h > 0 ? formatHour(h) : ""}
						</span>
					))}
				</div>
				{days.map((day, dayIndex) => (
					<DayColumn
						key={day.dateKey}
						day={day}
						dayIndex={dayIndex}
						now={now}
						onItemClick={onItemClick}
						onEmptyCellClick={onEmptyCellClick}
						objectMenu={objectMenu}
						onReschedule={onReschedule}
					/>
				))}
			</div>
		</section>
	);
}

function DayColumn({
	day,
	dayIndex,
	now,
	onItemClick,
	onEmptyCellClick,
	objectMenu,
	onReschedule,
}: {
	day: WeekDayBucket;
	dayIndex: number;
	now: number;
	onItemClick: ViewCallbacks["onItemClick"];
	onEmptyCellClick: ViewCallbacks["onEmptyCellClick"];
	objectMenu: ViewCallbacks["objectMenu"];
	onReschedule: ViewCallbacks["onReschedule"];
}) {
	const cls = [
		"cal-week__column",
		day.isToday ? "cal-week__column--today" : "",
		day.isWeekend ? "cal-week__column--weekend" : "",
	]
		.filter(Boolean)
		.join(" ");

	return (
		<div className={cls} data-day-start={String(day.dayStart)} data-day-index={String(dayIndex)}>
			{Array.from({ length: TOTAL_HOURS }, (_, h) => (
				<button
					// biome-ignore lint/suspicious/noArrayIndexKey: fixed 24-hour positional slots
					key={h}
					type="button"
					className="cal-week__slot"
					data-hour={String(h)}
					data-slot-start-ms={String(day.dayStart + h * 3_600_000)}
					style={{ top: `${h * HOUR_HEIGHT_PX}px`, height: `${HOUR_HEIGHT_PX}px` }}
					aria-label={t("calendar.slot.create", { time: formatHour(h) })}
					onClick={() => onEmptyCellClick(day.dayStart + h * 3_600_000)}
				/>
			))}
			{day.isToday ? (
				<div
					className="cal-week__now-line"
					style={{ top: `${minutesIntoDay(now) * (HOUR_HEIGHT_PX / 60)}px` }}
				/>
			) : null}
			{day.timedItems.map((item) => (
				<TimedBlock
					key={item.id}
					item={item}
					dayStart={day.dayStart}
					onItemClick={onItemClick}
					objectMenu={objectMenu}
					onReschedule={onReschedule}
				/>
			))}
		</div>
	);
}

function TimedBlock({
	item,
	dayStart,
	onItemClick,
	objectMenu,
	onReschedule,
}: {
	item: ScheduledItem;
	dayStart: number;
	onItemClick: ViewCallbacks["onItemClick"];
	objectMenu: ViewCallbacks["objectMenu"];
	onReschedule: ViewCallbacks["onReschedule"];
}) {
	const ref = useRef<HTMLButtonElement>(null);
	const startMins = clampToDay(minutesIntoDayFromEpoch(item.start, dayStart));
	const endMins = clampToDay(
		item.end === null ? startMins + 30 : minutesIntoDayFromEpoch(item.end, dayStart),
	);
	const heightMins = Math.max(20, endMins - startMins);
	const density = heightMins < 35 ? "tight" : heightMins < 55 ? "compact" : "roomy";
	const pxPerMin = HOUR_HEIGHT_PX / 60;

	const draggable = !item.isRecurringInstance && !item.readonly;
	useEffect(() => {
		const block = ref.current;
		if (!block || !draggable) return;
		block.classList.add("cal-chip--draggable");
		const onDown = (down: PointerEvent): void =>
			beginBlockDrag(down, block, item.start, dayStart, (newStart) => onReschedule(item, newStart));
		block.addEventListener("pointerdown", onDown);
		return () => block.removeEventListener("pointerdown", onDown);
	}, [draggable, item, dayStart, onReschedule]);

	return (
		<EventChip
			item={item}
			mode="block"
			onClick={onItemClick}
			objectMenu={objectMenu}
			density={density}
			buttonRef={ref}
			style={{ top: `${startMins * pxPerMin}px`, height: `${heightMins * pxPerMin}px` }}
		/>
	);
}
