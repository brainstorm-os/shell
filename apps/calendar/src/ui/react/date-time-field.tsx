/**
 * DateTimeField — the themed start/end picker for the event detail surface,
 * replacing the native `<input type="date">` / `<input type="datetime-local">`
 * that were inconsistent with every other date surface in the product
 * (F-229). The date half pops the shared `@brainstorm-os/sdk/calendar`
 * `openCalendarPopover`; the time half is a shared `<SelectMenu>` of
 * quarter-hour slots — neither uses OS chrome.
 *
 * It speaks the same `YYYY-MM-DD` / `YYYY-MM-DDTHH:MM` wall-clock string the
 * parent's tz-reinterpret + duration-carry logic already round-trips, so the
 * field stays presentational: it rewrites the date or time portion of that
 * string and hands it back through `onChange`.
 */

import { openCalendarPopover } from "@brainstorm-os/sdk/calendar";
import { SelectMenu, type SelectMenuOption } from "@brainstorm-os/sdk/select-menu";
import { type JSX, useMemo, useRef } from "react";
import { type TKey, t } from "../../i18n/t";
import { formatTime } from "../format-date";
import { SLOTS_PER_DAY, TIME_SLOT_MINUTES, isOnGrid } from "./date-time-field-logic";

type Parts = { year: number; month: number; day: number; hour: number; minute: number };

function parseValue(value: string): Parts | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(value);
	if (!m) return null;
	return {
		year: Number(m[1]),
		month: Number(m[2]),
		day: Number(m[3]),
		hour: Number(m[4] ?? 0),
		minute: Number(m[5] ?? 0),
	};
}

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

function dateString(p: Parts): string {
	return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

function timeString(p: Parts): string {
	return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

export function DateTimeField({
	labelKey,
	value,
	allDay,
	onChange,
}: {
	labelKey: TKey;
	value: string;
	allDay: boolean;
	onChange(value: string): void;
}): JSX.Element {
	const dateBtn = useRef<HTMLButtonElement>(null);
	const parts = parseValue(value);

	// The stored time when it sits between grid slots (e.g. 09:07) — kept as a
	// transient option so the menu shows the real time and re-confirming
	// round-trips it instead of silently snapping to the nearest quarter-hour
	// (F-229 finding #4). null once the user picks a grid slot.
	const offGridTime =
		parts && !allDay && !isOnGrid(parts.hour, parts.minute) ? timeString(parts) : null;

	const timeOptions = useMemo<SelectMenuOption[]>(() => {
		const out: SelectMenuOption[] = [];
		const base = new Date(2026, 0, 1, 0, 0, 0, 0);
		for (let i = 0; i < SLOTS_PER_DAY; i += 1) {
			const minutes = i * TIME_SLOT_MINUTES;
			const slot = new Date(base.getTime() + minutes * 60_000);
			out.push({
				value: `${pad2(slot.getHours())}:${pad2(slot.getMinutes())}`,
				label: formatTime(slot.getTime()),
			});
		}
		if (offGridTime) {
			const [hh, mm] = offGridTime.split(":").map(Number);
			const slot = new Date(2026, 0, 1, hh ?? 0, mm ?? 0, 0, 0);
			const insertAt = out.findIndex((o) => o.value > offGridTime);
			const option: SelectMenuOption = { value: offGridTime, label: formatTime(slot.getTime()) };
			out.splice(insertAt === -1 ? out.length : insertAt, 0, option);
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
		: t("calendar.detail.field.datePlaceholder");

	const openDatePicker = (): void => {
		const view = parts
			? new Date(parts.year, parts.month - 1, parts.day, 0, 0, 0, 0).getTime()
			: Date.now();
		openCalendarPopover({
			anchor: { element: dateBtn.current ?? document.body },
			ariaLabel: t(labelKey),
			labels: {
				today: t("calendar.date.today"),
				prev: t("calendar.detail.field.prevMonth"),
				next: t("calendar.detail.field.nextMonth"),
			},
			valueMs: view,
			viewMs: view,
			todayMs: Date.now(),
			onSelect: (ms) => {
				const d = new Date(ms);
				const next: Parts = {
					year: d.getFullYear(),
					month: d.getMonth() + 1,
					day: d.getDate(),
					hour: parts?.hour ?? 0,
					minute: parts?.minute ?? 0,
				};
				onChange(allDay ? dateString(next) : `${dateString(next)}T${timeString(next)}`);
			},
		});
	};

	const onTimeChange = (raw: string): void => {
		if (!parts) return;
		const [hh, mm] = raw.split(":").map(Number);
		const next: Parts = { ...parts, hour: hh ?? 0, minute: mm ?? 0 };
		onChange(`${dateString(next)}T${timeString(next)}`);
	};

	const timeValue = parts ? timeString(parts) : "";

	return (
		<div className="cal-detail__field">
			<span className="cal-detail__label">{t(labelKey)}</span>
			<div className="cal-detail__datetime">
				<button
					ref={dateBtn}
					type="button"
					className="cal-detail__date-trigger bs-input"
					onClick={openDatePicker}
					aria-label={t("calendar.detail.field.pickDate")}
				>
					<span className="cal-detail__date-text" data-empty={String(parts === null)}>
						{dateLabel}
					</span>
				</button>
				{allDay ? null : (
					<SelectMenu
						className="cal-detail__time"
						ariaLabel={t("calendar.detail.field.pickTime")}
						value={timeValue}
						options={timeOptions}
						onChange={onTimeChange}
					/>
				)}
			</div>
		</div>
	);
}
