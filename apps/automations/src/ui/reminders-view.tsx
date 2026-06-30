import { type ReminderDef, completeReminder, snoozeReminder } from "@brainstorm/sdk-types";
import { openCalendarPopover } from "@brainstorm/sdk/calendar";
import { formatRelativeDate, formatTime } from "@brainstorm/sdk/date-formatters";
import { EmptyState, EmptyStateTone } from "@brainstorm/sdk/empty-state";
import { Icon, IconName } from "@brainstorm/sdk/icon";
import { MenuAlign } from "@brainstorm/sdk/menus";
import { type AnchoredMenuItem, openAnchoredMenu } from "@brainstorm/sdk/object-menu";
import { SelectMenu, type SelectMenuOption } from "@brainstorm/sdk/select-menu";
import { type FormEvent, type ReactElement, useMemo, useRef, useState } from "react";
import { type AutomationsI18nKey, t } from "../i18n";
import {
	RECURRENCE_PRESETS,
	RecurrencePreset,
	ReminderStatus,
	buildReminder,
	reminderEffectiveDue,
	reminderStatus,
} from "../logic/reminder-capture";
import type { LoadedReminder } from "../storage/automation-repository";
import { RowMenu } from "./row-menu";

const SNOOZE_MS = 60 * 60 * 1000;

const RECURRENCE_LABEL: Record<RecurrencePreset, AutomationsI18nKey> = {
	[RecurrencePreset.None]: "recurrence.none",
	[RecurrencePreset.Daily]: "recurrence.daily",
	[RecurrencePreset.Weekdays]: "recurrence.weekdays",
	[RecurrencePreset.Weekly]: "recurrence.weekly",
	[RecurrencePreset.Monthly]: "recurrence.monthly",
};

const REMINDER_STATUS_LABEL: Record<ReminderStatus, AutomationsI18nKey> = {
	[ReminderStatus.Done]: "reminder.status.done",
	[ReminderStatus.Snoozed]: "reminder.status.snoozed",
	[ReminderStatus.Overdue]: "reminder.status.overdue",
	[ReminderStatus.Upcoming]: "reminder.status.upcoming",
};

const REL_LABELS = {
	today: t("date.today"),
	tomorrow: t("date.tomorrow"),
	yesterday: t("date.yesterday"),
};

function formatDay(iso: string, now: number): string {
	const ms = Date.parse(iso);
	if (Number.isNaN(ms)) return iso;
	return formatRelativeDate(ms, now, REL_LABELS);
}

const TIME_SLOT_MINUTES = 15;
const SLOTS_PER_DAY = (24 * 60) / TIME_SLOT_MINUTES;
const DEFAULT_DUE_TIME = "09:00";

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/** The local wall-clock `due` string the capture stores
 *  (`YYYY-MM-DDTHH:mm`, what `buildReminder` parses) split into its date /
 *  time halves, or `null` for the blank (no-date) state. */
type DueParts = { year: number; month: number; day: number; hour: number; minute: number };

function parseDue(value: string): DueParts | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
	if (!m) return null;
	return {
		year: Number(m[1]),
		month: Number(m[2]),
		day: Number(m[3]),
		hour: Number(m[4]),
		minute: Number(m[5]),
	};
}

function dueToString(p: DueParts): string {
	return `${p.year}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}`;
}

function timeOf(p: DueParts): string {
	return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** The themed due picker (F-229): a date trigger that pops the shared
 *  `@brainstorm/sdk/calendar` popover plus a quarter-hour time `<SelectMenu>`
 *  — no OS-native `<input type="datetime-local">`. Speaks the same
 *  `YYYY-MM-DDTHH:mm` wall-clock string the capture round-trips. */
function DueField({
	value,
	onChange,
}: {
	value: string;
	onChange: (next: string) => void;
}): ReactElement {
	const dateBtn = useRef<HTMLButtonElement>(null);
	const parts = parseDue(value);

	const offGridTime = parts && parts.minute % TIME_SLOT_MINUTES !== 0 ? timeOf(parts) : null;

	const timeOptions = useMemo<SelectMenuOption[]>(() => {
		const out: SelectMenuOption[] = [];
		const base = new Date(2026, 0, 1, 0, 0, 0, 0);
		for (let i = 0; i < SLOTS_PER_DAY; i += 1) {
			const slot = new Date(base.getTime() + i * TIME_SLOT_MINUTES * 60_000);
			out.push({
				value: `${pad2(slot.getHours())}:${pad2(slot.getMinutes())}`,
				label: formatTime(slot.getTime()),
			});
		}
		if (offGridTime) {
			const [hh, mm] = offGridTime.split(":").map(Number);
			const slot = new Date(2026, 0, 1, hh ?? 0, mm ?? 0, 0, 0);
			const insertAt = out.findIndex((o) => o.value > offGridTime);
			out.splice(insertAt === -1 ? out.length : insertAt, 0, {
				value: offGridTime,
				label: formatTime(slot.getTime()),
			});
		}
		return out;
	}, [offGridTime]);

	const dateLabel = parts
		? new Date(parts.year, parts.month - 1, parts.day).toLocaleDateString(undefined, {
				weekday: "short",
				month: "short",
				day: "numeric",
				year: "numeric",
			})
		: t("capture.due.empty");

	const openDatePicker = (): void => {
		const [defHh, defMm] = DEFAULT_DUE_TIME.split(":").map(Number);
		const view = parts
			? new Date(parts.year, parts.month - 1, parts.day, 0, 0, 0, 0).getTime()
			: Date.now();
		openCalendarPopover({
			anchor: { element: dateBtn.current ?? document.body },
			ariaLabel: t("capture.due"),
			labels: {
				today: t("capture.due.today"),
				prev: t("capture.due.prevMonth"),
				next: t("capture.due.nextMonth"),
			},
			valueMs: parts ? view : null,
			viewMs: view,
			todayMs: Date.now(),
			onSelect: (ms) => {
				const d = new Date(ms);
				onChange(
					dueToString({
						year: d.getFullYear(),
						month: d.getMonth() + 1,
						day: d.getDate(),
						hour: parts?.hour ?? defHh ?? 9,
						minute: parts?.minute ?? defMm ?? 0,
					}),
				);
			},
		});
	};

	const onTimeChange = (raw: string): void => {
		if (!parts) return;
		const [hh, mm] = raw.split(":").map(Number);
		onChange(dueToString({ ...parts, hour: hh ?? 0, minute: mm ?? 0 }));
	};

	return (
		<div className="au-capture__due">
			<button
				ref={dateBtn}
				type="button"
				className="au-capture__due-trigger au-menu-button"
				aria-haspopup="dialog"
				aria-label={t("capture.due.pickDate")}
				onClick={openDatePicker}
			>
				<span className="au-capture__due-text" data-empty={String(parts === null)}>
					{dateLabel}
				</span>
			</button>
			{parts ? (
				<>
					<SelectMenu
						className="au-capture__due-time"
						ariaLabel={t("capture.due.pickTime")}
						value={timeOf(parts)}
						options={timeOptions}
						onChange={onTimeChange}
					/>
					<button
						type="button"
						className="au-capture__due-clear"
						aria-label={t("capture.due.clear")}
						onClick={() => onChange("")}
					>
						<Icon name={IconName.Close} size={12} />
					</button>
				</>
			) : null}
		</div>
	);
}

export type RemindersViewProps = {
	reminders: LoadedReminder[];
	now: () => number;
	onAdd: (def: ReminderDef) => void;
	onMutate: (id: string, next: ReminderDef) => void;
	onDelete: (id: string) => void;
};

function Capture({
	now,
	onAdd,
}: {
	now: () => number;
	onAdd: (def: ReminderDef) => void;
}): ReactElement {
	const [subject, setSubject] = useState("");
	const [due, setDue] = useState("");
	const [recurrence, setRecurrence] = useState<RecurrencePreset>(RecurrencePreset.None);
	const subjectRef = useRef<HTMLInputElement>(null);
	const repeatRef = useRef<HTMLButtonElement>(null);

	// The one hard requirement (mirrors `buildReminder`): a blank subject
	// can't capture, so the primary renders disabled instead of silently
	// no-oping (F-219). The date stays optional (blank → defaultDue).
	const canSubmit = subject.trim() !== "";

	const submit = (event: FormEvent): void => {
		event.preventDefault();
		const def = buildReminder({ subject, dueLocal: due, recurrence }, now());
		if (!def) {
			subjectRef.current?.focus();
			return;
		}
		onAdd(def);
		setSubject("");
		setDue("");
		setRecurrence(RecurrencePreset.None);
		subjectRef.current?.focus();
	};

	const openRepeat = (): void => {
		const anchor = repeatRef.current;
		if (!anchor) return;
		const rect = anchor.getBoundingClientRect();
		const items: AnchoredMenuItem[] = RECURRENCE_PRESETS.map((preset) => ({
			label: t(RECURRENCE_LABEL[preset]),
			onSelect: () => setRecurrence(preset),
		}));
		openAnchoredMenu({ x: rect.left, y: rect.bottom }, items, {
			menuLabel: t("capture.repeat"),
			anchor,
			align: MenuAlign.Start,
		});
	};

	return (
		<form className="au-capture" onSubmit={submit}>
			<input
				ref={subjectRef}
				type="text"
				className="au-capture__subject"
				placeholder={t("capture.subject")}
				aria-label={t("capture.subject")}
				value={subject}
				onChange={(e) => setSubject(e.target.value)}
			/>
			<DueField value={due} onChange={setDue} />
			<button
				ref={repeatRef}
				type="button"
				className="au-capture__repeat au-menu-button"
				aria-haspopup="menu"
				aria-label={t("capture.repeat")}
				onClick={openRepeat}
			>
				{t(RECURRENCE_LABEL[recurrence])}
			</button>
			<button
				type="submit"
				className="bs-btn"
				data-bs-primary=""
				disabled={!canSubmit}
				aria-disabled={canSubmit ? undefined : "true"}
			>
				{t("capture.add")}
			</button>
		</form>
	);
}

function ReminderRow({
	reminder,
	now,
	onMutate,
	onDelete,
}: {
	reminder: LoadedReminder;
	now: () => number;
	onMutate: (id: string, next: ReminderDef) => void;
	onDelete: (id: string) => void;
}): ReactElement {
	const { id, def } = reminder;
	const status = reminderStatus(def, now());
	const items: AnchoredMenuItem[] = [
		{
			label: t("reminder.done"),
			icon: IconName.Check,
			onSelect: () => onMutate(id, completeReminder(def, now())),
		},
		{
			label: t("reminder.snooze"),
			icon: IconName.History,
			onSelect: () => onMutate(id, snoozeReminder(def, now() + SNOOZE_MS)),
		},
		{
			label: t("reminder.delete"),
			icon: IconName.Trash,
			destructive: true,
			onSelect: () => onDelete(id),
		},
	];

	return (
		<li className="au-row">
			<span className="au-row__name">{def.subject}</span>
			<span className="au-row__meta">{formatDay(reminderEffectiveDue(def, now()), now())}</span>
			<span className={`au-row__status au-pill au-pill--${status}`}>
				{t(REMINDER_STATUS_LABEL[status])}
			</span>
			{def.recurrence ? <span className="au-row__badge">{t("reminder.recurring")}</span> : null}
			<RowMenu menuLabel={t("reminder.actions")} items={items} />
		</li>
	);
}

export function RemindersView(props: RemindersViewProps): ReactElement {
	const { reminders, now } = props;
	return (
		<div className="au-section">
			<Capture now={now} onAdd={props.onAdd} />
			{reminders.length === 0 ? (
				<EmptyState
					tone={EmptyStateTone.Compact}
					icon={IconName.CheckCircle}
					title={t("reminders.empty")}
				/>
			) : (
				<ul className="au-list">
					{reminders.map((reminder) => (
						<ReminderRow
							key={reminder.id}
							reminder={reminder}
							now={now}
							onMutate={props.onMutate}
							onDelete={props.onDelete}
						/>
					))}
				</ul>
			)}
		</div>
	);
}
