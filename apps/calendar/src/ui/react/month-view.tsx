/**
 * Month view (React) — the SDK `<MonthGrid>` with a per-cell render-prop.
 * Each cell paints multi-day ribbon bands (reusing the pure
 * `logic/ribbon-layout`), a chip list capped at `MAX_VISIBLE_CHIPS` with a
 * "+N more" overflow pill, and a measuring pass after layout that trims
 * partially-clipped chips. Drag-to-reschedule + grid keyboard preserved.
 */

import { DragPayloadKind } from "@brainstorm-os/sdk-types";
import { attachGridCellKeyboard } from "@brainstorm-os/sdk/a11y";
import { MonthGrid, type MonthGridReactCell } from "@brainstorm-os/sdk/calendar";
import { DropSemantic, effectForSemantic, useDropTarget } from "@brainstorm-os/sdk/object-dnd";
import { openObjectMenu } from "@brainstorm-os/sdk/object-menu";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { t } from "../../i18n/t";
import {
	type CompiledMonthView,
	type MonthDayCell,
	isMultiDayItem,
} from "../../logic/compile-view";
import {
	type MonthRibbonLayout,
	type RibbonSegment,
	layoutMonthRibbons,
} from "../../logic/ribbon-layout";
import { type ScheduledItem, colorForItem } from "../../logic/scheduled-item";
import type { WeekStartsOn } from "../../types/calendar-view";
import { weekdayHeaderLabels } from "../format-date";
import { EventChip } from "./event-chip";
import { MoreButton } from "./more-button";
import { OverflowPopover } from "./overflow-popover";
import { beginMonthChipDrag } from "./use-chip-drag";
import type { ViewCallbacks } from "./view-callbacks";

const COLS_PER_WEEK = 7;
const MAX_VISIBLE_CHIPS = 3;

export type MonthViewProps = {
	compiled: CompiledMonthView;
	weekStartsOn: WeekStartsOn;
	callbacks: Pick<
		ViewCallbacks,
		"onItemClick" | "onDayClick" | "onEmptyCellClick" | "objectMenu" | "onReschedule" | "onDropObject"
	>;
};

function indexSegments(layout: MonthRibbonLayout): Map<string, RibbonSegment[]> {
	const map = new Map<string, RibbonSegment[]>();
	for (const seg of layout.segments) {
		const key = `${seg.week}:${seg.lane}`;
		const list = map.get(key);
		if (list) list.push(seg);
		else map.set(key, [seg]);
	}
	return map;
}

type OverflowState = { cell: MonthDayCell; items: ScheduledItem[]; anchor: DOMRect } | null;

export function MonthView({ compiled, weekStartsOn, callbacks }: MonthViewProps) {
	const { onItemClick, onDayClick, onEmptyCellClick, objectMenu, onReschedule, onDropObject } =
		callbacks;

	const focusMs = useMemo(
		() =>
			compiled.cells.find((c) => !c.isOtherMonth)?.dayStart ??
			compiled.cells[0]?.dayStart ??
			Date.now(),
		[compiled],
	);

	const ribbons = useMemo(() => layoutMonthRibbons(compiled.cells), [compiled]);
	const segmentsByWeekLane = useMemo(() => indexSegments(ribbons), [ribbons]);

	const firstInMonth = useMemo(() => {
		const idx = compiled.cells.findIndex((c) => !c.isOtherMonth);
		return idx >= 0 ? idx : 0;
	}, [compiled]);

	// KBN-A-calendar: arrows move the day cursor, Enter opens the focused day.
	// The grid container holds focus (aria-activedescendant); in-cell chips
	// stay mouse-only. Attached imperatively to the SDK-rendered grid (the
	// shared composite binding) behind this ref boundary, since the SDK
	// `<MonthGrid>` owns its own cell DOM.
	const hostRef = useRef<HTMLElement>(null);
	// `compiled` re-attaches the binding after the grid re-renders (the SDK
	// grid rebuilds its cells), so it's a deliberate re-run trigger.
	// biome-ignore lint/correctness/useExhaustiveDependencies: compiled triggers re-attach after grid rerender
	useEffect(() => {
		const grid = hostRef.current?.querySelector<HTMLElement>(".bs-cal-month__grid");
		if (!grid) return;
		const handle = attachGridCellKeyboard(grid, ".bs-cal-month__cell", {
			columns: COLS_PER_WEEK,
			initialIndex: firstInMonth,
			onOpenCell: (cell) => {
				const dayStart = Number(cell.dataset.dateEpochMs);
				if (Number.isFinite(dayStart)) onDayClick(dayStart);
			},
		});
		return () => handle.destroy();
	}, [firstInMonth, onDayClick, compiled]);

	const [overflow, setOverflow] = useState<OverflowState>(null);
	// `fitTrim[cellIndex]` = how many leading chips actually fit (after the
	// post-layout measuring pass). `null` = not yet measured / everything fits.
	const [fitTrim, setFitTrim] = useState<Record<number, number>>({});
	const listRefs = useRef<Map<number, HTMLUListElement>>(new Map());

	// Reset measurements whenever the compiled view changes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: compiled is the reset trigger
	useEffect(() => {
		setFitTrim({});
	}, [compiled]);

	// After layout, trim any chip partially clipped by the cell height and
	// re-emit the "+N more" pill with the corrected count.
	useLayoutEffect(() => {
		const next: Record<number, number> = {};
		let changed = false;
		for (const [index, list] of listRefs.current) {
			const listRect = list.getBoundingClientRect();
			const chipLis = Array.from(list.querySelectorAll<HTMLElement>(".cal-month__item"));
			let firstOverflowing = chipLis.length;
			for (let i = 0; i < chipLis.length; i++) {
				const li = chipLis[i];
				if (!li) continue;
				if (li.getBoundingClientRect().bottom > listRect.bottom + 0.5) {
					firstOverflowing = i;
					break;
				}
			}
			if (firstOverflowing < chipLis.length) {
				const keep = Math.max(0, firstOverflowing - 1);
				next[index] = keep;
				if (fitTrim[index] !== keep) changed = true;
			}
		}
		if (changed) setFitTrim((prev) => ({ ...prev, ...next }));
	});

	const setListRef = (index: number) => (el: HTMLUListElement | null) => {
		if (el) listRefs.current.set(index, el);
		else listRefs.current.delete(index);
	};

	// Both `compiled.cells` and the SDK grid are 42 cells in chronological
	// row-major order — pair them by the grid cell's own ordinal `index`.
	// (A call-order counter reset per render is NOT safe: StrictMode / any
	// child-only re-render invokes `renderCell` again without re-running this
	// body, which blanked every cell — F-316's investigation.)
	const renderCell = (gridCell: MonthGridReactCell): ReactNode => {
		const cellIndex = gridCell.index;
		const compiledCell = compiled.cells[cellIndex];
		if (!compiledCell) return null;

		const week = Math.floor(cellIndex / COLS_PER_WEEK);
		const col = cellIndex % COLS_PER_WEEK;
		const laneCount = ribbons.laneCountByWeek[week] ?? 0;

		const singleDayAllDay = compiledCell.allDayItems.filter((i) => !isMultiDayItem(i));
		const itemsInOrder: ScheduledItem[] = [...singleDayAllDay, ...compiledCell.timedItems];
		const measuredKeep = fitTrim[cellIndex];
		const visibleCount =
			measuredKeep !== undefined ? measuredKeep : Math.min(itemsInOrder.length, MAX_VISIBLE_CHIPS);
		const visible = itemsInOrder.slice(0, visibleCount);
		const overflowCount = itemsInOrder.length - visible.length;

		const cellContent = (
			<>
				{laneCount > 0 ? (
					<RibbonBand
						week={week}
						col={col}
						laneCount={laneCount}
						byWeekLane={segmentsByWeekLane}
						onItemClick={onItemClick}
						objectMenu={objectMenu}
					/>
				) : null}
				{itemsInOrder.length > 0 ? (
					<ul className="cal-month__items" ref={setListRef(cellIndex)}>
						{visible.map((item) => (
							<MonthChipItem
								key={item.id}
								item={item}
								onItemClick={onItemClick}
								objectMenu={objectMenu}
								onReschedule={onReschedule}
							/>
						))}
						{overflowCount > 0 ? (
							<li className="cal-month__overflow">
								<button
									type="button"
									className="cal-month__overflow-button"
									onClick={(e) => {
										e.stopPropagation();
										setOverflow({
											cell: compiledCell,
											items: itemsInOrder,
											anchor: (e.currentTarget as HTMLElement).getBoundingClientRect(),
										});
									}}
								>
									{t("calendar.event.overflow", { count: overflowCount })}
								</button>
							</li>
						) : null}
					</ul>
				) : null}
			</>
		);

		if (!onDropObject) return cellContent;
		return (
			<MonthDayDropCell dayStart={compiledCell.dayStart} onDropObject={onDropObject}>
				{cellContent}
			</MonthDayDropCell>
		);
	};

	return (
		<section className="cal-month-host" ref={hostRef}>
			<MonthGrid
				focusMs={focusMs}
				todayMs={Date.now()}
				weekStartsOn={weekStartsOn}
				weekdayLabels={weekdayHeaderLabels(weekStartsOn)}
				onEmptyCellClick={(cell) => onEmptyCellClick(cell.dateEpochMs)}
				onDateClick={(cell) => onDayClick(cell.dateEpochMs)}
				renderCell={renderCell}
			/>
			{overflow ? (
				<OverflowPopover
					cell={overflow.cell}
					items={overflow.items}
					anchor={overflow.anchor}
					onItemClick={onItemClick}
					onDayClick={onDayClick}
					objectMenu={objectMenu}
					onClose={() => setOverflow(null)}
				/>
			) : null}
		</section>
	);
}

/** A month day cell wrapped as a cross-app object drop target (DND-4). Dropping
 *  an object dragged from another app onto the cell sets that object's date
 *  property to the cell's day (`DropSemantic.SetProperty`). Each cell gets its
 *  own `useDropTarget` (a hook can't be called per-cell in a loop), so this is a
 *  child component; the LIFO cross-app registry routes a drop to the cell under
 *  the pointer. `nativeDisabled` because intra-renderer DnD inside the calendar
 *  is the chip-reschedule pointer path, not HTML5 entity DnD. */
function MonthDayDropCell({
	dayStart,
	onDropObject,
	children,
}: {
	dayStart: number;
	onDropObject: NonNullable<ViewCallbacks["onDropObject"]>;
	children: ReactNode;
}) {
	const { dropProps, dropRef, isOver } = useDropTarget({
		nativeDisabled: true,
		accepts: (info) => info.payloadKind === DragPayloadKind.Object,
		dropEffectFor: () => effectForSemantic(DropSemantic.SetProperty),
		onDrop: (payload) => onDropObject(dayStart, payload),
	});
	return (
		<div
			ref={dropRef}
			className="cal-month__drop"
			data-drop-over={isOver ? "true" : undefined}
			{...dropProps}
		>
			{children}
		</div>
	);
}

function MonthChipItem({
	item,
	onItemClick,
	objectMenu,
	onReschedule,
}: {
	item: ScheduledItem;
	onItemClick: ViewCallbacks["onItemClick"];
	objectMenu: ViewCallbacks["objectMenu"];
	onReschedule: ViewCallbacks["onReschedule"];
}) {
	const ref = useRef<HTMLButtonElement>(null);
	const draggable = !item.isRecurringInstance && !item.readonly;
	useEffect(() => {
		const chip = ref.current;
		if (!chip || !draggable) return;
		chip.classList.add("cal-chip--draggable");
		const onDown = (down: PointerEvent): void =>
			beginMonthChipDrag(down, chip, item.start, (newStart) => onReschedule(item, newStart));
		chip.addEventListener("pointerdown", onDown);
		return () => chip.removeEventListener("pointerdown", onDown);
	}, [draggable, item, onReschedule]);

	return (
		<li className="cal-month__item">
			<EventChip
				item={item}
				mode="compact"
				onClick={onItemClick}
				objectMenu={objectMenu}
				buttonRef={ref}
			/>
		</li>
	);
}

function RibbonBand({
	week,
	col,
	laneCount,
	byWeekLane,
	onItemClick,
	objectMenu,
}: {
	week: number;
	col: number;
	laneCount: number;
	byWeekLane: Map<string, RibbonSegment[]>;
	onItemClick: ViewCallbacks["onItemClick"];
	objectMenu: ViewCallbacks["objectMenu"];
}) {
	const lanes: ReactNode[] = [];
	for (let lane = 0; lane < laneCount; lane++) {
		const seg = (byWeekLane.get(`${week}:${lane}`) ?? []).find(
			(s) => col >= s.startCol && col <= s.endCol,
		);
		lanes.push(
			seg ? (
				<RibbonSegmentView
					key={lane}
					seg={seg}
					col={col}
					onItemClick={onItemClick}
					objectMenu={objectMenu}
				/>
			) : (
				<div key={lane} className="cal-month__ribbon-gap" />
			),
		);
	}
	return <div className="cal-month__ribbons">{lanes}</div>;
}

function RibbonSegmentView({
	seg,
	col,
	onItemClick,
	objectMenu,
}: {
	seg: RibbonSegment;
	col: number;
	onItemClick: ViewCallbacks["onItemClick"];
	objectMenu: ViewCallbacks["objectMenu"];
}) {
	const isStart = col === seg.startCol;
	const isEnd = col === seg.endCol;
	const style = { ["--chip-color" as string]: colorForItem(seg.item) };
	const common = {
		className: "cal-month__ribbon",
		style,
		"data-item-id": seg.item.id,
		...(isStart && seg.roundedLeft ? { "data-cap-left": "true" } : {}),
		...(isEnd && seg.roundedRight ? { "data-cap-right": "true" } : {}),
		...(seg.item.statusKey ? { "data-status": seg.item.statusKey } : {}),
	};

	if (isStart) {
		return (
			<button
				type="button"
				{...common}
				aria-label={seg.item.title}
				onClick={() => onItemClick(seg.item)}
				onContextMenu={
					objectMenu
						? (e) => {
								const ctx = objectMenu(seg.item);
								if (!ctx) return;
								e.preventDefault();
								void openObjectMenu({ x: e.clientX, y: e.clientY }, ctx);
							}
						: undefined
				}
			>
				<span className="cal-month__ribbon-title">{seg.item.title}</span>
				{objectMenu ? (
					<MoreButton
						context={() => objectMenu(seg.item)}
						label={t("calendar.event.moreActions")}
						className="cal-month__ribbon-more"
					/>
				) : null}
			</button>
		);
	}
	// continuation segment of a multi-day ribbon — aria-hidden (the start segment's button represents the event to AT); click is a mouse convenience, keyboard lives on that start button.
	// kbn-onclick-exempt: aria-hidden ribbon continuation; keyboard activation is on the start segment's button.
	return <div {...common} aria-hidden="true" onClick={() => onItemClick(seg.item)} />;
}
