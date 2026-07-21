/**
 * DateCell — Date value behind a small `<CellPopover>`. The popover pairs
 * a natural-language text input ("tomorrow", "next monday", "in 3 days")
 * with a month calendar so the value can be typed OR picked; parsing
 * routes through `parseDateInput` in `format.ts` — the cell never
 * re-implements it. A live preview shows the resolved date as the user
 * types, and clicking a calendar day commits immediately.
 *
 * One factory backs every registered Date view: Pill / Plain / Calendar
 * render the absolute date at rest; Relative renders "in 3 days" /
 * "Yesterday" (the popover editor is identical).
 */

import {
	type CellProps,
	DateGranularity,
	type DateValue,
	ValueType,
} from "@brainstorm-os/sdk-types";
import type { JSX } from "react";
import { useCallback, useMemo, useState } from "react";
import {
	WeekStartsOn,
	addMonths,
	buildMonthGrid,
	startOfDay,
	weekdayLabels,
} from "../../date-grid/date-grid";
import { coerceValue } from "../../properties-validate";
import { usePropertyUiSeams } from "../use-properties";
import { CellPopover } from "./cell-popover";
import { formatDate, formatRelativeDate, parseDateInput } from "./format";

const WEEK_STARTS_ON = WeekStartsOn.Sunday;

function makeDateCell(relative: boolean) {
	return function DateCell(props: CellProps): JSX.Element {
		const { property, value, onChange, readOnly, autoEdit, onAutoEditHandled } = props;
		const { labels } = usePropertyUiSeams();
		if (property.valueType !== ValueType.Date) {
			throw new Error(`DateCell registered against ${property.valueType}; expected Date`);
		}
		const current = value && typeof value === "object" ? (value as DateValue) : null;
		const display = relative ? formatRelativeDate(current) : formatDate(current);

		const commit = useCallback(
			(parsed: unknown) => onChange(coerceValue(property, parsed) as never),
			[onChange, property],
		);

		return (
			<CellPopover
				trigger={
					display.length === 0 ? (
						<span className="bs-cell-date-empty">{labels.cellEmpty}</span>
					) : (
						<span className="bs-cell-date-value">{display}</span>
					)
				}
				triggerClassName="bs-cell-date-trigger"
				triggerAriaLabel={labels.cellEditValueFor(property.name)}
				disabled={readOnly}
				panelAriaLabel={labels.datePickerRegion(property.name)}
				autoOpen={autoEdit}
				onAutoOpenHandled={onAutoEditHandled}
			>
				{(close) => (
					<DatePopoverBody
						granularity={property.granularity}
						current={current}
						onCommit={(parsed) => {
							commit(parsed);
							close();
						}}
						onClear={() => {
							commit(null);
							close();
						}}
					/>
				)}
			</CellPopover>
		);
	};
}

function DatePopoverBody({
	granularity,
	current,
	onCommit,
	onClear,
}: {
	granularity: DateGranularity | undefined;
	current: DateValue | null;
	onCommit: (parsed: unknown) => void;
	onClear: () => void;
}): JSX.Element {
	const { labels, commitMatcher } = usePropertyUiSeams();
	const [draft, setDraft] = useState("");
	const parsed = useMemo(() => parseDateInput(draft, granularity), [draft, granularity]);
	const preview = parsed ? formatDate(parsed) : "";

	const commit = useCallback(() => {
		if (parsed) onCommit(parsed);
	}, [parsed, onCommit]);

	const pickDay = useCallback(
		(dayMs: number) => {
			onCommit({ at: startOfDay(dayMs), granularity: granularity ?? DateGranularity.Date });
		},
		[granularity, onCommit],
	);

	// The calendar previews the typed draft while editing, else the value.
	const selectedMs = parsed?.at ?? current?.at ?? null;

	return (
		<div className="bs-cell-date-pop">
			<input
				type="text"
				className="bs-cell-pop-input"
				placeholder={labels.datePlaceholder}
				aria-label={labels.dateInput}
				value={draft}
				// biome-ignore lint/a11y/noAutofocus: focus the date input on open, mirroring the tag picker.
				autoFocus
				onChange={(e) => setDraft(e.target.value)}
				onKeyDown={(e) => {
					if (commitMatcher(e)) {
						e.preventDefault();
						commit();
					}
				}}
			/>
			<div className="bs-cell-date-preview" aria-live="polite">
				{draft.trim().length === 0
					? labels.dateHint
					: preview.length > 0
						? preview
						: labels.dateUnrecognised}
			</div>
			<DateCalendar
				selectedMs={selectedMs}
				onPick={pickDay}
				prevMonthLabel={labels.datePrevMonth ?? "Previous month"}
				nextMonthLabel={labels.dateNextMonth ?? "Next month"}
			/>
			<div className="bs-cell-date-actions">
				<button type="button" className="bs-cell-date-set" disabled={!parsed} onClick={commit}>
					{labels.dateSet}
				</button>
				<button type="button" className="bs-cell-date-clear" onClick={onClear}>
					{labels.dateClear}
				</button>
			</div>
		</div>
	);
}

function DateCalendar({
	selectedMs,
	onPick,
	prevMonthLabel,
	nextMonthLabel,
}: {
	selectedMs: number | null;
	onPick: (dayMs: number) => void;
	prevMonthLabel: string;
	nextMonthLabel: string;
}): JSX.Element {
	const [nowMs] = useState(() => Date.now());
	const [focusMs, setFocusMs] = useState(() => selectedMs ?? nowMs);
	const rows = useMemo(() => buildMonthGrid(focusMs, nowMs, WEEK_STARTS_ON), [focusMs, nowMs]);
	const headers = useMemo(() => weekdayLabels(WEEK_STARTS_ON), []);
	const monthLabel = useMemo(
		() => new Date(focusMs).toLocaleDateString(undefined, { month: "long", year: "numeric" }),
		[focusMs],
	);
	const selectedKey = selectedMs === null ? null : startOfDay(selectedMs);

	return (
		<div className="bs-cell-cal">
			<div className="bs-cell-cal-nav">
				<button
					type="button"
					className="bs-cell-cal-arrow"
					aria-label={prevMonthLabel}
					onClick={() => setFocusMs((ms) => addMonths(ms, -1))}
				>
					‹
				</button>
				<span className="bs-cell-cal-month">{monthLabel}</span>
				<button
					type="button"
					className="bs-cell-cal-arrow"
					aria-label={nextMonthLabel}
					onClick={() => setFocusMs((ms) => addMonths(ms, 1))}
				>
					›
				</button>
			</div>
			<div className="bs-cell-cal-weekdays" aria-hidden="true">
				{headers.map((h, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: a fixed 7-entry, never-reordered weekday header row — the position IS the identity, and short labels can repeat (S/S).
					<span key={i} className="bs-cell-cal-weekday">
						{h}
					</span>
				))}
			</div>
			<div className="bs-cell-cal-grid">
				{rows.flat().map((cell) => {
					const selected = selectedKey !== null && startOfDay(cell.dateEpochMs) === selectedKey;
					const cls = [
						"bs-cell-cal-day",
						cell.inMonth ? "" : "bs-cell-cal-day--muted",
						cell.isToday ? "bs-cell-cal-day--today" : "",
						selected ? "bs-cell-cal-day--selected" : "",
					]
						.filter(Boolean)
						.join(" ");
					return (
						<button
							key={cell.dateKey}
							type="button"
							className={cls}
							aria-pressed={selected}
							onClick={() => onPick(cell.dateEpochMs)}
						>
							{cell.dayOfMonth}
						</button>
					);
				})}
			</div>
		</div>
	);
}

export const DateCell = makeDateCell(false);
export const RelativeDateCell = makeDateCell(true);
