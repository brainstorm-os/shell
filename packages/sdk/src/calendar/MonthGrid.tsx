/**
 * React twin of `createMonthGrid` — renders the same chrome-less 6×7 grid
 * with the same `.bs-cal-month__*` classes, `data-date-key` /
 * `data-date-epoch-ms` attributes, and `--today` / `--other-month` /
 * `--weekend` / `--selected` state classes. React apps (Calendar) compose
 * this so their month surface is bit-identical with the plain-DOM apps'.
 *
 * The host supplies what goes *inside* each cell via the `renderCell`
 * render-prop (a React node mounted into `.bs-cal-month__content`), mirroring
 * the imperative helper's `renderCell(cell)` content-slot callback.
 */

import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import {
	type GridCell,
	WeekStartsOn,
	buildMonthGrid,
	weekdayLabels as defaultWeekdayLabels,
	isSameDay,
} from "../date-grid/date-grid";
import { MonthGridDensity } from "./month-grid";

const DEFAULT_WEEK_START = WeekStartsOn.Sunday;

/** A grid cell handed to the React render-prop. Mirrors the data half of the
 *  imperative `MonthGridCell` — the host renders content from these fields
 *  rather than appending into a DOM `contentSlot`. */
export type MonthGridReactCell = GridCell & {
	isSelected: boolean;
};

export type MonthGridProps = {
	/** Any epoch-ms inside the month to render. */
	focusMs: number;
	/** Anchor for the "today" highlight. Defaults to `Date.now()`. */
	todayMs?: number;
	/** Selected date for the `--selected` highlight. */
	selectedMs?: number | null;
	weekStartsOn?: WeekStartsOn;
	/** Custom weekday short labels in display order (7 entries). */
	weekdayLabels?: ReadonlyArray<string>;
	/** Show the weekday header row. Default `true`. */
	showWeekdays?: boolean;
	density?: MonthGridDensity;
	/** Extra class on the root grid element. */
	className?: string;
	/** Returns the content node for each cell's `.bs-cal-month__content` slot. */
	renderCell?(cell: MonthGridReactCell): ReactNode;
	/** Click on the date number. When present the date renders as a
	 *  `<button>` (focusable); when absent it renders as a `<span>`. */
	onDateClick?(cell: MonthGridReactCell, ev: ReactMouseEvent): void;
	/** Click on empty cell space (not on a `<button>`/`<a>`). */
	onEmptyCellClick?(cell: MonthGridReactCell, ev: ReactMouseEvent): void;
};

function rootClass(density: MonthGridDensity, extra: string | undefined): string {
	const base =
		density === MonthGridDensity.Compact ? "bs-cal-month bs-cal-month--compact" : "bs-cal-month";
	return extra ? `${base} ${extra}` : base;
}

function cellClass(cell: MonthGridReactCell): string {
	const classes = ["bs-cal-month__cell"];
	if (!cell.inMonth) classes.push("bs-cal-month__cell--other-month");
	if (cell.isToday) classes.push("bs-cal-month__cell--today");
	if (cell.isWeekend) classes.push("bs-cal-month__cell--weekend");
	if (cell.isSelected) classes.push("bs-cal-month__cell--selected");
	return classes.join(" ");
}

export function MonthGrid({
	focusMs,
	todayMs,
	selectedMs,
	weekStartsOn,
	weekdayLabels,
	showWeekdays = true,
	density = MonthGridDensity.Full,
	className,
	renderCell,
	onDateClick,
	onEmptyCellClick,
}: MonthGridProps) {
	const wk = weekStartsOn ?? DEFAULT_WEEK_START;
	const labels = weekdayLabels ?? defaultWeekdayLabels(wk);
	const rows = buildMonthGrid(focusMs, todayMs ?? Date.now(), wk);
	const selected = selectedMs ?? null;

	return (
		<div className={rootClass(density, className)}>
			{showWeekdays ? (
				<div className="bs-cal-month__weekdays">
					{labels.map((label, i) => (
						// Weekday header is a fixed 7-entry list; position IS the
						// stable identity (narrow labels like "S"/"S" repeat).
						// biome-ignore lint/suspicious/noArrayIndexKey: fixed positional header
						<span key={i} className="bs-cal-month__weekday">
							{label}
						</span>
					))}
				</div>
			) : null}
			<div className="bs-cal-month__grid">
				{rows.flat().map((raw) => {
					const cell: MonthGridReactCell = {
						...raw,
						isSelected: selected != null && isSameDay(raw.dateEpochMs, selected),
					};
					const onCellClick = onEmptyCellClick
						? (ev: ReactMouseEvent) => {
								if ((ev.target as HTMLElement).closest("button, a, [role='button']")) return;
								onEmptyCellClick(cell, ev);
							}
						: undefined;
					return (
						// The keyboard path into a cell is the focusable date <button>
						// (present whenever a host wires interaction); onEmptyCellClick is
						// a pointer-only convenience that mirrors the imperative helper.
						// kbn-onclick-exempt: the cell's focusable date <button> owns keyboard activation.
						// biome-ignore lint/a11y/useKeyWithClickEvents: date button owns keyboard activation
						<div
							key={raw.dateKey}
							className={cellClass(cell)}
							data-date-key={raw.dateKey}
							data-date-epoch-ms={String(raw.dateEpochMs)}
							onClick={onCellClick}
						>
							{onDateClick ? (
								<button
									type="button"
									className="bs-cal-month__date"
									onClick={(ev) => onDateClick(cell, ev)}
								>
									{raw.dayOfMonth}
								</button>
							) : (
								<span className="bs-cal-month__date">{raw.dayOfMonth}</span>
							)}
							<div className="bs-cal-month__content">{renderCell?.(cell)}</div>
						</div>
					);
				})}
			</div>
		</div>
	);
}
