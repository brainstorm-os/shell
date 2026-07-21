/**
 * React twin of `createRecurrenceEditor` — same `bs-recur__*` chrome, the same
 * kind selector swapping daily/weekly/monthly-by-day/monthly-by-weekday/
 * yearly/custom controls with a live summary caption. React apps (Calendar
 * 9.15.x, Tasks) render through this so their recurrence surface is
 * bit-identical with the plain-DOM apps'.
 *
 * Fully controlled: the host owns `value` and updates it from `onChange`,
 * mirroring how `MiniCalendar` turned the imperative `getValue`/`onSelect`
 * into `value`/`onChange`. Picking a kind from the selector re-seeds the value
 * through `defaultRecurrenceForKind(start)`; every sub-control edit re-coerces
 * through the pure `recurrence-edit` helpers — no recurrence math lives here.
 *
 * Every dropdown (kind / monthly ordinal / monthly weekday / yearly month)
 * renders through the shared select-menu control in BOTH twins, so the DOM,
 * keyboard model, theming, and a11y stay bit-identical AND both ride the one
 * fancy-menus runtime instead of native `<select>` popups (the no-bespoke-
 * menu-chrome rule). The host renderer must have a menu host mounted
 * (`mountMenuHost()` / `<BrainstormMenuProvider>`), as every app already does.
 */

import {
	type Recurrence,
	RecurrenceKind,
	type RecurrenceSummaryLabels,
	WEEKDAYS,
	type Weekday,
} from "@brainstorm-os/sdk-types";
import {
	REPEAT_KINDS,
	type RepeatKind,
	clampInterval,
	coerceRecurrence,
	defaultRecurrenceForKind,
	normalizeWeekdays,
	recurrenceCaption,
	repeatKindOf,
	weekdayForDate,
} from "../recurrence-edit";
import { SelectMenu } from "../select-menu";
import type { RecurrenceEditorLabels } from "./recurrence-editor";

const ORDINALS: readonly (1 | 2 | 3 | 4 | -1)[] = Object.freeze([1, 2, 3, 4, -1]);

export type RecurrenceEditorProps = {
	value: Recurrence | null;
	/** The anchor instant — seeds every kind's default (event start, task
	 *  due/scheduled date, …). */
	start: number;
	labels: RecurrenceEditorLabels;
	/** Weekday / ordinal / month names + the summary vocabulary — the host
	 *  builds these from its own i18n via `buildRecurrenceLabels(t)`. Drives
	 *  the weekday buttons, the month/ordinal selects, and the live summary. */
	summaryLabels: RecurrenceSummaryLabels;
	onChange(value: Recurrence | null): void;
};

export function RecurrenceEditor({
	value,
	start,
	labels,
	summaryLabels,
	onChange,
}: RecurrenceEditorProps) {
	const current = coerceRecurrence(value);
	const kind = repeatKindOf(current);

	const emit = (next: Recurrence | null): void => onChange(coerceRecurrence(next));

	const onKindChange = (nextKind: RepeatKind): void => {
		emit(defaultRecurrenceForKind(nextKind, start));
	};

	const caption = recurrenceCaption(current, labels.kind[kind], summaryLabels);

	return (
		<div className="bs-recur">
			<SelectMenu
				className="bs-recur__kind"
				ariaLabel={labels.fieldLabel}
				value={kind}
				options={REPEAT_KINDS.map((k) => ({ value: k, label: labels.kind[k] }))}
				onChange={onKindChange}
			/>
			{current ? (
				<div className="bs-recur__body">
					<KindControls rec={current} start={start} labels={labels} sum={summaryLabels} emit={emit} />
				</div>
			) : null}
			{caption !== null ? (
				<p className="bs-recur__summary" aria-live="polite">
					{caption}
				</p>
			) : null}
		</div>
	);
}

type EmitFn = (next: Recurrence | null) => void;

function KindControls({
	rec,
	start,
	labels,
	sum,
	emit,
}: {
	rec: Recurrence;
	start: number;
	labels: RecurrenceEditorLabels;
	sum: RecurrenceSummaryLabels;
	emit: EmitFn;
}) {
	switch (rec.kind) {
		case RecurrenceKind.Daily:
			return <IntervalRow rec={rec} unitText={labels.unitDays} labels={labels} emit={emit} />;
		case RecurrenceKind.Weekly:
			return (
				<>
					<IntervalRow rec={rec} unitText={labels.unitWeeks} labels={labels} emit={emit} />
					<WeekdayToggles rec={rec} start={start} labels={labels} sum={sum} emit={emit} />
				</>
			);
		case RecurrenceKind.Monthly:
			return (
				<>
					<IntervalRow rec={rec} unitText={labels.unitMonths} labels={labels} emit={emit} />
					<MonthlyPattern rec={rec} start={start} labels={labels} sum={sum} emit={emit} />
				</>
			);
		case RecurrenceKind.Yearly:
			return <YearlyControls rec={rec} labels={labels} sum={sum} emit={emit} />;
		case RecurrenceKind.Custom:
			return <CustomControls rec={rec} labels={labels} emit={emit} />;
	}
}

function IntervalRow({
	rec,
	unitText,
	labels,
	emit,
}: {
	rec: Extract<Recurrence, { every: number }>;
	unitText: string;
	labels: RecurrenceEditorLabels;
	emit: EmitFn;
}) {
	return (
		<div className="bs-recur__row">
			<span className="bs-recur__inline-label">{labels.editEvery}</span>
			<input
				type="number"
				min="1"
				className="bs-recur__interval bs-recur__input"
				value={String(rec.every)}
				aria-label={labels.intervalLabel}
				onChange={(ev) => emit({ ...rec, every: clampInterval(Number(ev.target.value)) })}
			/>
			<span className="bs-recur__inline-label">{unitText}</span>
		</div>
	);
}

type WeeklyRec = Extract<Recurrence, { kind: RecurrenceKind.Weekly }>;

function WeekdayToggles({
	rec,
	start,
	labels,
	sum,
	emit,
}: {
	rec: WeeklyRec;
	start: number;
	labels: RecurrenceEditorLabels;
	sum: RecurrenceSummaryLabels;
	emit: EmitFn;
}) {
	const anchor = weekdayForDate(start);
	const selected = new Set<Weekday>(rec.days);

	const toggle = (day: Weekday): void => {
		const next = new Set(selected);
		if (next.has(day)) next.delete(day);
		else next.add(day);
		emit({ ...rec, days: normalizeWeekdays([...next], anchor) });
	};

	return (
		<div className="bs-recur__weekdays" role="group" aria-label={labels.onDays}>
			{WEEKDAYS.map((day) => {
				const on = selected.has(day);
				return (
					<button
						key={day}
						type="button"
						className="bs-recur__weekday"
						data-weekday={day}
						data-selected={String(on)}
						role="checkbox"
						aria-checked={on}
						onClick={() => toggle(day)}
					>
						{sum.weekdayShort[day]}
					</button>
				);
			})}
		</div>
	);
}

type MonthlyRec = Extract<Recurrence, { kind: RecurrenceKind.Monthly }>;

function MonthlyPattern({
	rec,
	start,
	labels,
	sum,
	emit,
}: {
	rec: MonthlyRec;
	start: number;
	labels: RecurrenceEditorLabels;
	sum: RecurrenceSummaryLabels;
	emit: EmitFn;
}) {
	const date = new Date(start);
	const fallbackDay = date.getDate();
	const fallbackWeekday = weekdayForDate(start);
	const fallbackOrdinal = ordinalForDate(start);

	const usesDay = rec.dayOfMonth !== undefined;
	const dayValue = rec.dayOfMonth ?? fallbackDay;
	const ordValue = rec.dayOfWeek?.ordinal ?? fallbackOrdinal;
	const wdValue = rec.dayOfWeek?.weekday ?? fallbackWeekday;

	const applyDay = (day: number): void =>
		emit({ kind: RecurrenceKind.Monthly, every: rec.every, dayOfMonth: clampDayOfMonth(day) });
	const applyWeekday = (ordinal: 1 | 2 | 3 | 4 | -1, weekday: Weekday): void =>
		emit({ kind: RecurrenceKind.Monthly, every: rec.every, dayOfWeek: { weekday, ordinal } });

	return (
		// The options are native <input type="radio"> sharing one name, so the
		// platform owns roving focus + arrow navigation — no custom composite
		// keyboard handling to route through @brainstorm-os/sdk/a11y.
		// kbn-roles-exempt
		<div className="bs-recur__monthly" role="radiogroup" aria-label={labels.monthlyMode}>
			<label className="bs-recur__monthly-option">
				<input
					type="radio"
					name="bs-recur-monthly"
					className="bs-recur__radio"
					checked={usesDay}
					onChange={() => applyDay(dayValue)}
				/>
				<span>{labels.monthlyByDayLabel}</span>
				<input
					type="number"
					min="1"
					max="31"
					className="bs-recur__interval bs-recur__input"
					value={String(dayValue)}
					aria-label={labels.yearlyDay}
					onChange={(ev) => applyDay(Number(ev.target.value))}
				/>
			</label>
			<label className="bs-recur__monthly-option">
				<input
					type="radio"
					name="bs-recur-monthly"
					className="bs-recur__radio"
					checked={!usesDay}
					onChange={() => applyWeekday(ordValue, wdValue)}
				/>
				<span>{labels.monthlyByWeekdayLabel}</span>
				<SelectMenu
					ariaLabel={labels.monthlyByWeekdayLabel}
					value={String(ordValue)}
					options={ORDINALS.map((ord) => ({
						value: String(ord),
						label: sum.ordinal[String(ord) as keyof typeof sum.ordinal],
					}))}
					onChange={(next) => applyWeekday(Number(next) as 1 | 2 | 3 | 4 | -1, wdValue)}
				/>
				<SelectMenu
					ariaLabel={labels.onDays}
					value={wdValue}
					options={WEEKDAYS.map((wd) => ({ value: wd, label: sum.weekdayShort[wd] }))}
					onChange={(next) => applyWeekday(ordValue, next)}
				/>
			</label>
		</div>
	);
}

type YearlyRec = Extract<Recurrence, { kind: RecurrenceKind.Yearly }>;

function YearlyControls({
	rec,
	labels,
	sum,
	emit,
}: {
	rec: YearlyRec;
	labels: RecurrenceEditorLabels;
	sum: RecurrenceSummaryLabels;
	emit: EmitFn;
}) {
	return (
		<div className="bs-recur__row">
			<SelectMenu
				ariaLabel={labels.yearlyMonth}
				value={String(rec.month)}
				options={MONTHS.map((m) => ({ value: String(m), label: sum.monthName(m) }))}
				onChange={(next) => emit({ ...rec, month: Number(next) })}
			/>
			<input
				type="number"
				min="1"
				max="31"
				className="bs-recur__interval bs-recur__input"
				value={String(rec.day)}
				aria-label={labels.yearlyDay}
				onChange={(ev) => emit({ ...rec, day: clampDayOfMonth(Number(ev.target.value)) })}
			/>
		</div>
	);
}

type CustomRec = Extract<Recurrence, { kind: RecurrenceKind.Custom }>;

function CustomControls({
	rec,
	labels,
	emit,
}: {
	rec: CustomRec;
	labels: RecurrenceEditorLabels;
	emit: EmitFn;
}) {
	return (
		<label className="bs-recur__row">
			<span className="bs-recur__inline-label">{labels.customLabel}</span>
			<input
				type="text"
				className="bs-recur__input"
				value={rec.rrule}
				placeholder={labels.customPlaceholder}
				onChange={(ev) => emit({ ...rec, rrule: ev.target.value.trim() })}
			/>
		</label>
	);
}

const MONTHS: readonly number[] = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

function clampDayOfMonth(value: number): number {
	if (!Number.isFinite(value)) return 1;
	return Math.min(31, Math.max(1, Math.floor(value)));
}

function ordinalForDate(epochMs: number): 1 | 2 | 3 | 4 | -1 {
	const date = new Date(epochMs);
	const nth = Math.ceil(date.getDate() / 7);
	return nth >= 4 ? 4 : (nth as 1 | 2 | 3 | 4);
}
