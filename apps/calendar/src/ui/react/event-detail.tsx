/**
 * Event detail / create surface (React) — the write half of the Calendar app,
 * built on the shared `<Popover>`. The object icon uses the SDK icon picker
 * (`openIconPicker`); status / colour are radiogroups; recurrence is the
 * shared `<RecurrenceEditor>`; attendees use the in-app React editor.
 *
 * Saving routes through `EventsRepository.save`, the path that exercises the
 * declared `entities.write:brainstorm/Event/v1` capability (the host owns the
 * repo write; this surface only emits the resolved result).
 */

import type { Icon } from "@brainstorm/sdk-types";
import { Checkbox } from "@brainstorm/sdk/checkbox";
import { LockButton } from "@brainstorm/sdk/lock-button";
import { type ObjectMenuContext, openObjectMenu } from "@brainstorm/sdk/object-menu";
import { closePicker, openIconPicker } from "@brainstorm/sdk/picker-host";
import { Popover, PopoverBodyPadding, PopoverSize } from "@brainstorm/sdk/popover";
import { RecurrenceEditor } from "@brainstorm/sdk/recurrence-editor";
import { SelectMenu, type SelectMenuOption } from "@brainstorm/sdk/select-menu";
import { matchesChord } from "@brainstorm/sdk/shortcut";
import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useMemo, useState } from "react";
import { calendarRecurrenceEditorLabels } from "../../i18n/recurrence-editor-labels";
import { recurrenceLabels } from "../../i18n/recurrence-labels";
import { type TKey, t } from "../../i18n/t";
import { EVENT_COLOR_PRESETS, normalizeColorHint } from "../../logic/event-colors";
import {
	EVENT_STATUSES,
	EventStatus,
	normalizeStatusKey,
	statusToStored,
} from "../../logic/event-status";
import { REMINDER_PRESET_MINUTES, normalizeReminders, toggleReminder } from "../../logic/reminders";
import {
	commonTimeZones,
	groupedTimeZones,
	normalizeTimeZone,
	utcToZonedParts,
	zonedTimeToUtc,
} from "../../logic/timezone";
import type { Attendee } from "../../types/attendee";
import type { Event } from "../../types/event";
import { reminderOffsetLabel } from "../reminder-labels";
import { AttendeeEditor } from "./attendee-editor";
import { DateTimeField } from "./date-time-field";
import { EntityIcon } from "./entity-icon";
import { MoreButton } from "./more-button";
import { RadioGroup } from "./radio-group";

export enum EventDetailOutcome {
	Saved = "saved",
	Deleted = "deleted",
}

export type EventDetailResult =
	| { kind: EventDetailOutcome.Saved; event: Event }
	| { kind: EventDetailOutcome.Deleted; id: string };

export type EventDetailProps = {
	event: Event | null;
	defaultStart: number;
	onResolve(result: EventDetailResult): void;
	onClose(): void;
	/** Object-menu context for the open Event (editing only). */
	objectMenu?: () => ObjectMenuContext;
	/** Read-only lock — the open event's synced `locked` property. When true
	 *  the form is read-only (Save/Delete suppressed); only Unlock + Cancel. */
	locked?: boolean;
	/** Toggle the lock — persists `!locked` on the event. Only wired for an
	 *  existing event. */
	onToggleLock?: () => void;
};

const HOUR_MS = 3_600_000;

const STATUS_LABEL_KEY: Record<EventStatus, TKey> = {
	[EventStatus.Confirmed]: "calendar.status.confirmed",
	[EventStatus.Tentative]: "calendar.status.tentative",
	[EventStatus.Cancelled]: "calendar.status.cancelled",
};

function newDraft(start: number): Event {
	const now = Date.now();
	return {
		id: `evt-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		title: "",
		icon: null,
		start,
		end: start + HOUR_MS,
		allDay: false,
		location: null,
		recurrence: null,
		statusKey: null,
		colorHint: null,
		reminders: [],
		attendees: [],
		timeZone: null,
		createdAt: now,
		updatedAt: now,
	};
}

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

function toLocalInputValue(epochMs: number, dateOnly: boolean): string {
	const d = new Date(epochMs);
	const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
	return dateOnly ? date : `${date}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fromLocalInputValue(value: string): number | null {
	if (!value) return null;
	const ms = new Date(value).getTime();
	return Number.isFinite(ms) ? ms : null;
}

function toInputValue(epochMs: number, dateOnly: boolean, tz: string | null): string {
	if (tz === null) return toLocalInputValue(epochMs, dateOnly);
	const p = utcToZonedParts(epochMs, tz);
	const date = `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
	return dateOnly ? date : `${date}T${pad2(p.hour)}:${pad2(p.minute)}`;
}

function fromInputValue(value: string, dateOnly: boolean, tz: string | null): number | null {
	if (tz === null) return fromLocalInputValue(value);
	const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(value);
	if (!m) return null;
	return zonedTimeToUtc(
		{
			year: Number(m[1]),
			month: Number(m[2]),
			day: Number(m[3]),
			hour: dateOnly ? 0 : Number(m[4] ?? 0),
			minute: dateOnly ? 0 : Number(m[5] ?? 0),
		},
		tz,
	);
}

function Field({ labelKey, children }: { labelKey: TKey; children: ReactNode }): ReactNode {
	return (
		// biome-ignore lint/a11y/noLabelWithoutControl: control is the nested input/group
		<label className="cal-detail__field">
			<span className="cal-detail__label">{t(labelKey)}</span>
			{children}
		</label>
	);
}

export function EventDetail({
	event,
	defaultStart,
	onResolve,
	onClose,
	objectMenu,
	locked,
	onToggleLock,
}: EventDetailProps) {
	const isCreate = event === null;
	const [draft, setDraft] = useState<Event>(() => (event ? { ...event } : newDraft(defaultStart)));
	// `<input>` string values (committed back to `draft` on change). Kept in
	// their own state so the duration-carry + tz-reinterpret edits can rewrite
	// the displayed wall-clock independently of the underlying instant.
	const [startStr, setStartStr] = useState(() =>
		toInputValue(draft.start, draft.allDay, draft.timeZone),
	);
	const [endStr, setEndStr] = useState(() =>
		toInputValue(draft.end ?? draft.start + HOUR_MS, draft.allDay, draft.timeZone),
	);
	const [error, setError] = useState<string | null>(null);

	const patch = (next: Partial<Event>): void => setDraft((d) => ({ ...d, ...next }));

	const tzGroups = useMemo(() => groupedTimeZones(), []);
	const known = useMemo(() => new Set(tzGroups.flatMap((g) => g.zones)), [tzGroups]);
	const extraZone =
		draft.timeZone && normalizeTimeZone(draft.timeZone) && !known.has(draft.timeZone)
			? draft.timeZone
			: null;
	const tzOptions = useMemo<SelectMenuOption[]>(() => {
		const options: SelectMenuOption[] = [{ value: "", label: t("calendar.detail.tz.local") }];
		if (extraZone) options.push({ value: extraZone, label: extraZone });
		const common = t("calendar.detail.tz.common");
		for (const zone of commonTimeZones()) options.push({ value: zone, label: zone, group: common });
		for (const region of tzGroups) {
			for (const zone of region.zones) {
				options.push({ value: zone, label: zone, group: region.region });
			}
		}
		return options;
	}, [extraZone, tzGroups]);

	const onAllDayToggle = (allDay: boolean): void => {
		setDraft((d) => {
			const next = { ...d, allDay };
			setStartStr(toInputValue(next.start, allDay, next.timeZone));
			setEndStr(toInputValue(next.end ?? next.start + HOUR_MS, allDay, next.timeZone));
			return next;
		});
	};

	const onTzChange = (raw: string): void => {
		const tz = raw.length > 0 ? raw : null;
		const s = fromInputValue(startStr, draft.allDay, tz);
		const e = fromInputValue(endStr, draft.allDay, tz);
		patch({
			timeZone: tz,
			...(s !== null ? { start: s } : {}),
			...(e !== null ? { end: e } : {}),
		});
	};

	const onStartChange = (value: string): void => {
		setStartStr(value);
		const newStart = fromInputValue(value, draft.allDay, draft.timeZone);
		if (newStart === null) return;
		// Carry the end by the same delta to preserve duration (F-025).
		const curEnd = fromInputValue(endStr, draft.allDay, draft.timeZone);
		setDraft((d) => {
			let nextEnd = d.end;
			if (curEnd !== null) {
				const shiftedEnd = curEnd + (newStart - d.start);
				setEndStr(toInputValue(shiftedEnd, d.allDay, d.timeZone));
				nextEnd = shiftedEnd;
			}
			return { ...d, start: newStart, end: nextEnd };
		});
	};

	const onEndChange = (value: string): void => {
		setEndStr(value);
		const e = fromInputValue(value, draft.allDay, draft.timeZone);
		if (e !== null) patch({ end: e });
	};

	const chooseIcon = (): void => {
		openIconPicker({
			value: draft.icon ?? null,
			onChange: (icon: Icon | null) => {
				patch({ icon });
				closePicker();
			},
		});
	};

	const save = (): void => {
		const title = draft.title.trim();
		if (title.length === 0) {
			setError(t("calendar.detail.validation.title"));
			return;
		}
		const start = fromInputValue(startStr, draft.allDay, draft.timeZone) ?? draft.start;
		const end = fromInputValue(endStr, draft.allDay, draft.timeZone);
		if (end !== null && end < start) {
			setError(t("calendar.detail.validation.endBeforeStart"));
			return;
		}
		const location = (draft.location ?? "").trim();
		const description = (draft.description ?? "").trim();
		const { description: _drop, ...rest } = draft;
		const next: Event = {
			...rest,
			title,
			start,
			end: draft.allDay ? null : end,
			location: location.length > 0 ? location : null,
			updatedAt: Date.now(),
			...(description.length > 0 ? { description } : {}),
		};
		onResolve({ kind: EventDetailOutcome.Saved, event: next });
		closePicker();
		onClose();
	};

	// keyboard-exempt: Enter commits the dialog's single primary action from
	// the title <input> (F-218); the shortcut registry suppresses single keys
	// in editable fields by design. Chord matching stays on the shared parser.
	const onTitleKey = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
		if (matchesChord(event.nativeEvent, "Enter")) {
			event.preventDefault();
			save();
		}
	};

	const del = (): void => {
		onResolve({ kind: EventDetailOutcome.Deleted, id: draft.id });
		closePicker();
		onClose();
	};

	const moreOpen =
		draft.timeZone != null ||
		(draft.location ?? "") !== "" ||
		draft.recurrence != null ||
		draft.statusKey != null ||
		draft.colorHint != null ||
		draft.reminders.length > 0 ||
		draft.attendees.length > 0 ||
		(draft.description ?? "") !== "";

	const statusValue = normalizeStatusKey(draft.statusKey) ?? EventStatus.Confirmed;
	const colorValue = normalizeColorHint(draft.colorHint);
	const selectedReminders = new Set(normalizeReminders(draft.reminders));

	const footer = (
		<div className="cal-detail__footer">
			{!isCreate && !locked ? (
				<button type="button" className="bs-btn bs-btn--danger" onClick={del}>
					{t("calendar.detail.delete")}
				</button>
			) : null}
			{!isCreate && onToggleLock ? (
				<LockButton
					locked={!!locked}
					onToggle={onToggleLock}
					lockLabel={t("calendar.detail.lock")}
					unlockLabel={t("calendar.detail.unlock")}
				/>
			) : null}
			<span className="cal-detail__footer-spacer" />
			<button
				type="button"
				className="bs-btn bs-btn--secondary"
				onClick={() => {
					closePicker();
					onClose();
				}}
			>
				{t("calendar.detail.cancel")}
			</button>
			{!locked ? (
				<button type="button" className="bs-btn" data-bs-primary="" onClick={save}>
					{t("calendar.detail.save")}
				</button>
			) : null}
		</div>
	);

	return (
		<Popover
			title={isCreate ? t("calendar.detail.createTitle") : t("calendar.detail.editTitle")}
			onClose={() => {
				closePicker();
				onClose();
			}}
			footer={footer}
			size={PopoverSize.Medium}
			bodyPadding={PopoverBodyPadding.Comfortable}
		>
			{/* A locked event is read-only: `disabled` on the fieldset freezes every
			    input/control inside. The Lock/Unlock + Cancel live in the footer
			    (outside the fieldset), so unlocking stays reachable. */}
			<fieldset className="cal-detail__lock-fieldset" disabled={!!locked}>
				<div className="cal-detail">
					<div
						className="cal-detail__title-row"
						onContextMenu={
							!isCreate && objectMenu
								? (e) => {
										const ctx = objectMenu();
										if (!ctx) return;
										e.preventDefault();
										void openObjectMenu({ x: e.clientX, y: e.clientY }, ctx);
									}
								: undefined
						}
					>
						<button
							type="button"
							className="cal-detail__icon"
							aria-label={t("calendar.detail.field.iconChoose")}
							onClick={chooseIcon}
						>
							<EntityIcon icon={draft.icon ?? null} size={22} />
						</button>
						<input
							type="text"
							className="cal-detail__input cal-detail__input--title"
							value={draft.title}
							placeholder={t("calendar.detail.field.titlePlaceholder")}
							aria-label={t("calendar.detail.field.title")}
							onChange={(e) => patch({ title: e.target.value })}
							onKeyDown={onTitleKey}
							// biome-ignore lint/a11y/noAutofocus: detail dialog focuses the title on open
							autoFocus
						/>
						{!isCreate && objectMenu ? (
							<MoreButton
								context={objectMenu}
								label={t("calendar.event.moreActions")}
								className="cal-detail__more"
							/>
						) : null}
					</div>

					<div className="cal-detail__field cal-detail__field--inline">
						<span className="cal-detail__label">{t("calendar.detail.field.allDay")}</span>
						<Checkbox
							ariaLabel={t("calendar.detail.field.allDay")}
							checked={draft.allDay}
							onChange={onAllDayToggle}
						/>
					</div>

					<DateTimeField
						labelKey="calendar.detail.field.start"
						value={startStr}
						allDay={draft.allDay}
						onChange={onStartChange}
					/>
					<DateTimeField
						labelKey="calendar.detail.field.end"
						value={endStr}
						allDay={draft.allDay}
						onChange={onEndChange}
					/>

					<details className="cal-detail__more" open={moreOpen}>
						<summary className="cal-detail__more-summary">{t("calendar.detail.more")}</summary>

						<Field labelKey="calendar.detail.field.timeZone">
							<SelectMenu
								className="cal-detail__tz"
								ariaLabel={t("calendar.detail.field.timeZone")}
								value={draft.timeZone ?? ""}
								options={tzOptions}
								onChange={onTzChange}
							/>
						</Field>

						<Field labelKey="calendar.detail.field.location">
							<input
								type="text"
								className="cal-detail__input"
								value={draft.location ?? ""}
								placeholder={t("calendar.detail.field.locationPlaceholder")}
								onChange={(e) => patch({ location: e.target.value })}
							/>
						</Field>

						<Field labelKey="calendar.detail.field.status">
							<RadioGroup
								className="cal-detail__segmented"
								ariaLabel={t("calendar.detail.field.status")}
								value={statusValue}
								onChange={(status) => patch({ statusKey: statusToStored(status) })}
								options={EVENT_STATUSES.map((status) => ({
									value: status,
									className: "cal-detail__segment",
									label: t(STATUS_LABEL_KEY[status]),
									dataset: { "data-status": status },
									children: t(STATUS_LABEL_KEY[status]),
								}))}
							/>
						</Field>

						<Field labelKey="calendar.detail.field.color">
							<RadioGroup
								className="cal-detail__swatches"
								ariaLabel={t("calendar.detail.field.color")}
								value={colorValue}
								onChange={(color) => patch({ colorHint: color })}
								options={[
									{
										value: null,
										className: "cal-detail__swatch cal-detail__swatch--none",
										label: t("calendar.color.none"),
										dataset: { "data-color": "none" },
									},
									...EVENT_COLOR_PRESETS.map((preset) => ({
										value: preset.value as string | null,
										className: "cal-detail__swatch",
										label: t("calendar.color.choose", { color: t(`calendar.color.${preset.key}` as TKey) }),
										dataset: { "data-color": preset.key },
										style: { "--swatch-color": preset.value },
									})),
								]}
							/>
						</Field>

						<Field labelKey="calendar.detail.field.repeat">
							<RecurrenceEditor
								value={draft.recurrence}
								start={draft.start}
								labels={calendarRecurrenceEditorLabels()}
								summaryLabels={recurrenceLabels()}
								onChange={(rec) => patch({ recurrence: rec })}
							/>
						</Field>

						<Field labelKey="calendar.detail.field.reminders">
							<div
								className="cal-detail__reminders"
								role="group"
								aria-label={t("calendar.detail.field.reminders")}
							>
								{REMINDER_PRESET_MINUTES.map((minutes) => {
									const on = selectedReminders.has(minutes);
									return (
										<button
											key={minutes}
											type="button"
											className="cal-detail__reminder"
											data-minutes={String(minutes)}
											aria-pressed={on}
											data-selected={String(on)}
											onClick={() => patch({ reminders: toggleReminder([...selectedReminders], minutes) })}
										>
											{reminderOffsetLabel(minutes)}
										</button>
									);
								})}
							</div>
						</Field>

						<Field labelKey="calendar.detail.field.attendees">
							<AttendeeEditor value={draft.attendees} onChange={(attendees) => patch({ attendees })} />
						</Field>

						<Field labelKey="calendar.detail.field.description">
							<textarea
								className="cal-detail__textarea"
								rows={3}
								value={draft.description ?? ""}
								placeholder={t("calendar.detail.field.descriptionPlaceholder")}
								onChange={(e) => patch({ description: e.target.value })}
							/>
						</Field>
					</details>

					<p className="cal-detail__error" role="alert" hidden={error === null}>
						{error}
					</p>
				</div>
			</fieldset>
		</Popover>
	);
}
