/**
 * `@brainstorm-os/sdk/recurrence-editor` — the shared write-half of the
 * `Recurrence` union, mounted wherever a recurring object is authored
 * (Calendar events 9.15.13, Tasks 9.14.12). A kind selector (none / daily /
 * weekly / monthly / yearly / custom) swaps in kind-specific controls; every
 * edit re-coerces through the pure `recurrence-edit` helpers and re-renders a
 * live human summary via `summarizeRecurrence`, so the user sees exactly what
 * the chip will say ("Every 2 weeks on Mon, Wed"). Every dropdown renders
 * through the shared select-menu control (same as the React twin), so the
 * host renderer must have a menu host mounted (`mountMenuHost()`).
 *
 * Extracted from `apps/calendar/src/ui/recurrence-editor.ts` at the second
 * consumer ([[feedback_extract_to_sdk_at_copy_two]]). The host app injects the
 * UI strings via `labels` AND the weekday/ordinal/month + summary vocabulary
 * via `summaryLabels` (`buildRecurrenceLabels(t)`), so this stays i18n-agnostic.
 * Classes are neutral `bs-recur__*`; ship `recurrence-editor.css` with it.
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
import { createSelectMenu } from "../select-menu";

const ORDINALS: readonly (1 | 2 | 3 | 4 | -1)[] = Object.freeze([1, 2, 3, 4, -1]);

/** Host-supplied UI strings — the app maps these from its own i18n. */
export type RecurrenceEditorLabels = {
	fieldLabel: string;
	kind: Record<RepeatKind, string>;
	editEvery: string;
	unitDays: string;
	unitWeeks: string;
	unitMonths: string;
	intervalLabel: string;
	onDays: string;
	monthlyMode: string;
	monthlyByDayLabel: string;
	monthlyByWeekdayLabel: string;
	yearlyMonth: string;
	yearlyDay: string;
	customLabel: string;
	customPlaceholder: string;
};

export type RecurrenceEditorHandle = {
	element: HTMLElement;
	getValue(): Recurrence | null;
};

export type RecurrenceEditorOptions = {
	value: Recurrence | null;
	/** The anchor instant — seeds every kind's default (event start, task
	 *  due/scheduled date, …). */
	start: number;
	labels: RecurrenceEditorLabels;
	/** Weekday / ordinal / month names + the summary vocabulary — the host
	 *  builds these from its own i18n via `buildRecurrenceLabels(t)`. Drives
	 *  the weekday buttons, the month/ordinal selects, and the live summary. */
	summaryLabels: RecurrenceSummaryLabels;
	onChange?: (value: Recurrence | null) => void;
};

export function createRecurrenceEditor(opts: RecurrenceEditorOptions): RecurrenceEditorHandle {
	const { labels, summaryLabels } = opts;
	let current: Recurrence | null = coerceRecurrence(opts.value);

	const root = document.createElement("div");
	root.className = "bs-recur";

	const kindSelect = createSelectMenu<RepeatKind>({
		options: REPEAT_KINDS.map((kind) => ({ value: kind, label: labels.kind[kind] })),
		value: repeatKindOf(current),
		ariaLabel: labels.fieldLabel,
		className: "bs-recur__kind",
		onChange: (kind) => {
			current = defaultRecurrenceForKind(kind, opts.start);
			rebuild(true);
		},
	});

	const body = document.createElement("div");
	body.className = "bs-recur__body";

	const summary = document.createElement("p");
	summary.className = "bs-recur__summary";
	summary.setAttribute("aria-live", "polite");

	// The caption adds information the select doesn't already carry — it's
	// hidden when it would just echo the selected option (F-153).
	const renderSummary = (): void => {
		current = coerceRecurrence(current);
		const caption = recurrenceCaption(current, labels.kind[repeatKindOf(current)], summaryLabels);
		summary.textContent = caption ?? "";
		summary.hidden = caption === null;
	};
	// `notify` is what the sub-controls call on a user edit — it refreshes the
	// summary AND tells the host. The initial build refreshes the summary WITHOUT
	// notifying, so opening the editor never fires `onChange` (a mount-time emit
	// would persist + re-render in hosts that save on change — Tasks 9.14.12).
	const notify = (): void => {
		renderSummary();
		opts.onChange?.(current);
	};

	const rebuild = (notifyHost: boolean): void => {
		body.replaceChildren();
		if (current) buildKindControls(current, body, notify, opts.start, labels, summaryLabels);
		if (notifyHost) notify();
		else renderSummary();
	};

	root.append(kindSelect.element, body, summary);
	rebuild(false);

	return {
		element: root,
		getValue: () => coerceRecurrence(current),
	};
}

function buildKindControls(
	rec: Recurrence,
	body: HTMLElement,
	emit: () => void,
	start: number,
	labels: RecurrenceEditorLabels,
	sum: RecurrenceSummaryLabels,
): void {
	switch (rec.kind) {
		case RecurrenceKind.Daily:
			body.appendChild(intervalRow(rec, labels.unitDays, emit, labels));
			return;
		case RecurrenceKind.Weekly:
			body.appendChild(intervalRow(rec, labels.unitWeeks, emit, labels));
			body.appendChild(weekdayToggles(rec, emit, start, labels, sum));
			return;
		case RecurrenceKind.Monthly:
			body.appendChild(intervalRow(rec, labels.unitMonths, emit, labels));
			body.appendChild(monthlyPattern(rec, emit, start, labels, sum));
			return;
		case RecurrenceKind.Yearly:
			body.appendChild(yearlyControls(rec, emit, labels, sum));
			return;
		case RecurrenceKind.Custom:
			body.appendChild(customControls(rec, emit, labels));
			return;
	}
}

function intervalRow(
	rec: { every: number },
	unitText: string,
	emit: () => void,
	labels: RecurrenceEditorLabels,
): HTMLElement {
	const row = document.createElement("div");
	row.className = "bs-recur__row";

	const prefix = document.createElement("span");
	prefix.className = "bs-recur__inline-label";
	prefix.textContent = labels.editEvery;

	const input = document.createElement("input");
	input.type = "number";
	input.min = "1";
	input.className = "bs-recur__interval bs-recur__input";
	input.value = String(rec.every);
	input.setAttribute("aria-label", labels.intervalLabel);
	input.addEventListener("input", () => {
		rec.every = clampInterval(Number(input.value));
		emit();
	});

	const unit = document.createElement("span");
	unit.className = "bs-recur__inline-label";
	unit.textContent = unitText;

	row.append(prefix, input, unit);
	return row;
}

function weekdayToggles(
	rec: { days: readonly Weekday[] },
	emit: () => void,
	start: number,
	labels: RecurrenceEditorLabels,
	sum: RecurrenceSummaryLabels,
): HTMLElement {
	const wrap = document.createElement("div");
	wrap.className = "bs-recur__weekdays";
	wrap.setAttribute("role", "group");
	wrap.setAttribute("aria-label", labels.onDays);
	const anchor = weekdayForDate(start);
	const selected = new Set<Weekday>(rec.days);

	for (const day of WEEKDAYS) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "bs-recur__weekday";
		btn.dataset.weekday = day;
		btn.setAttribute("role", "checkbox");
		btn.textContent = sum.weekdayShort[day];
		const paint = (): void => {
			const on = selected.has(day);
			btn.setAttribute("aria-checked", String(on));
			btn.dataset.selected = String(on);
		};
		btn.addEventListener("click", () => {
			if (selected.has(day)) selected.delete(day);
			else selected.add(day);
			rec.days = normalizeWeekdays([...selected], anchor);
			selected.clear();
			for (const d of rec.days) selected.add(d);
			for (const el of wrap.querySelectorAll<HTMLElement>(".bs-recur__weekday")) {
				const wd = el.dataset.weekday as Weekday;
				const on = selected.has(wd);
				el.setAttribute("aria-checked", String(on));
				el.dataset.selected = String(on);
			}
			emit();
		});
		paint();
		wrap.appendChild(btn);
	}
	return wrap;
}

type MonthlyRec = Extract<Recurrence, { kind: RecurrenceKind.Monthly }>;

function monthlyPattern(
	rec: MonthlyRec,
	emit: () => void,
	start: number,
	labels: RecurrenceEditorLabels,
	sum: RecurrenceSummaryLabels,
): HTMLElement {
	const wrap = document.createElement("div");
	wrap.className = "bs-recur__monthly";
	// The options are native <input type="radio"> sharing one name, so the
	// platform owns roving focus + arrow navigation — no custom composite
	// keyboard handling to route through @brainstorm-os/sdk/a11y.
	// kbn-roles-exempt
	wrap.setAttribute("role", "radiogroup");
	wrap.setAttribute("aria-label", labels.monthlyMode);

	const date = new Date(start);
	const fallbackDay = date.getDate();
	const fallbackWeekday = weekdayForDate(start);
	const fallbackOrdinal = ordinalForDate(start);

	const dayRow = document.createElement("label");
	dayRow.className = "bs-recur__monthly-option";
	const dayRadio = radio("bs-recur-monthly");
	const dayNum = document.createElement("input");
	dayNum.type = "number";
	dayNum.min = "1";
	dayNum.max = "31";
	dayNum.className = "bs-recur__interval bs-recur__input";
	dayNum.value = String(rec.dayOfMonth ?? fallbackDay);
	dayNum.setAttribute("aria-label", labels.yearlyDay);
	const dayLabel = document.createElement("span");
	dayLabel.textContent = labels.monthlyByDayLabel;
	dayRow.append(dayRadio, dayLabel, dayNum);

	const wdRow = document.createElement("label");
	wdRow.className = "bs-recur__monthly-option";
	const wdRadio = radio("bs-recur-monthly");
	const ordSelect = createSelectMenu({
		options: ORDINALS.map((ord) => ({
			value: String(ord),
			label: sum.ordinal[String(ord) as keyof typeof sum.ordinal],
		})),
		value: String(rec.dayOfWeek?.ordinal ?? fallbackOrdinal),
		ariaLabel: labels.monthlyByWeekdayLabel,
		onChange: () => {
			wdRadio.checked = true;
			applyWeekday();
		},
	});
	const wdSelect = createSelectMenu<Weekday>({
		options: WEEKDAYS.map((wd) => ({ value: wd, label: sum.weekdayShort[wd] })),
		value: rec.dayOfWeek?.weekday ?? fallbackWeekday,
		ariaLabel: labels.onDays,
		onChange: () => {
			wdRadio.checked = true;
			applyWeekday();
		},
	});
	const wdLabel = document.createElement("span");
	wdLabel.textContent = labels.monthlyByWeekdayLabel;
	wdRow.append(wdRadio, wdLabel, ordSelect.element, wdSelect.element);

	const usesDay = rec.dayOfMonth !== undefined;
	dayRadio.checked = usesDay;
	wdRadio.checked = !usesDay;

	const applyDay = (): void => {
		rec.dayOfMonth = clampDayOfMonth(Number(dayNum.value));
		// biome-ignore lint/performance/noDelete: discriminant swap needs the inactive field truly absent; = undefined is blocked by exactOptionalPropertyTypes
		delete rec.dayOfWeek;
		emit();
	};
	const applyWeekday = (): void => {
		// biome-ignore lint/performance/noDelete: discriminant swap needs the inactive field truly absent; = undefined is blocked by exactOptionalPropertyTypes
		delete rec.dayOfMonth;
		rec.dayOfWeek = {
			weekday: wdSelect.getValue() ?? fallbackWeekday,
			ordinal: Number(ordSelect.getValue() ?? fallbackOrdinal) as 1 | 2 | 3 | 4 | -1,
		};
		emit();
	};

	dayRadio.addEventListener("change", () => {
		if (dayRadio.checked) applyDay();
	});
	wdRadio.addEventListener("change", () => {
		if (wdRadio.checked) applyWeekday();
	});
	dayNum.addEventListener("input", () => {
		dayRadio.checked = true;
		applyDay();
	});

	wrap.append(dayRow, wdRow);
	return wrap;
}

type YearlyRec = Extract<Recurrence, { kind: RecurrenceKind.Yearly }>;

function yearlyControls(
	rec: YearlyRec,
	emit: () => void,
	labels: RecurrenceEditorLabels,
	sum: RecurrenceSummaryLabels,
): HTMLElement {
	const row = document.createElement("div");
	row.className = "bs-recur__row";

	const monthSelect = createSelectMenu({
		options: Array.from({ length: 12 }, (_, i) => ({
			value: String(i + 1),
			label: sum.monthName(i + 1),
		})),
		value: String(rec.month),
		ariaLabel: labels.yearlyMonth,
		onChange: (next) => {
			rec.month = Number(next);
			emit();
		},
	});

	const dayNum = document.createElement("input");
	dayNum.type = "number";
	dayNum.min = "1";
	dayNum.max = "31";
	dayNum.className = "bs-recur__interval bs-recur__input";
	dayNum.value = String(rec.day);
	dayNum.setAttribute("aria-label", labels.yearlyDay);

	dayNum.addEventListener("input", () => {
		rec.day = clampDayOfMonth(Number(dayNum.value));
		emit();
	});

	row.append(monthSelect.element, dayNum);
	return row;
}

type CustomRec = Extract<Recurrence, { kind: RecurrenceKind.Custom }>;

function customControls(
	rec: CustomRec,
	emit: () => void,
	labels: RecurrenceEditorLabels,
): HTMLElement {
	const wrap = document.createElement("label");
	wrap.className = "bs-recur__row";
	const label = document.createElement("span");
	label.className = "bs-recur__inline-label";
	label.textContent = labels.customLabel;
	const input = document.createElement("input");
	input.type = "text";
	input.className = "bs-recur__input";
	input.value = rec.rrule;
	input.placeholder = labels.customPlaceholder;
	input.addEventListener("input", () => {
		rec.rrule = input.value.trim();
		emit();
	});
	wrap.append(label, input);
	return wrap;
}

function radio(name: string): HTMLInputElement {
	const r = document.createElement("input");
	r.type = "radio";
	r.name = name;
	r.className = "bs-recur__radio";
	return r;
}

function clampDayOfMonth(value: number): number {
	if (!Number.isFinite(value)) return 1;
	return Math.min(31, Math.max(1, Math.floor(value)));
}

function ordinalForDate(epochMs: number): 1 | 2 | 3 | 4 | -1 {
	const date = new Date(epochMs);
	const nth = Math.ceil(date.getDate() / 7);
	return nth >= 4 ? 4 : (nth as 1 | 2 | 3 | 4);
}
