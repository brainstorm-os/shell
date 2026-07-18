/**
 * Bulk-reschedule popover (React) — moves a whole selection to a new day
 * (preserving each event's time-of-day + the gaps between them, via the pure
 * `bulkShiftToDate`). Pre-filled with the batch's current earliest day.
 */

import { Popover, PopoverBodyPadding, PopoverSize } from "@brainstorm/sdk/popover";
import { useState } from "react";
import { t } from "../../i18n/t";
import { DateTimeField } from "./date-time-field";

export type BulkRescheduleProps = {
	count: number;
	/** Pre-filled target (the batch's current earliest day). */
	defaultDayStart: number;
	/** Popover title override — the DND-6 single-item "Move to date…" twin
	 *  names the item instead of the "{count} events" batch phrasing. */
	title?: string;
	onMove(targetDayStart: number): void;
	onClose(): void;
};

function dateInputToMs(value: string): number | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (!m) return null;
	return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

function msToDateInput(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function BulkReschedule({
	count,
	defaultDayStart,
	title,
	onMove,
	onClose,
}: BulkRescheduleProps) {
	const [value, setValue] = useState(msToDateInput(defaultDayStart));

	const move = (): void => {
		const ms = dateInputToMs(value);
		if (ms === null) return;
		onClose();
		onMove(ms);
	};

	return (
		<Popover
			title={title ?? t("calendar.bulk.title", { count })}
			onClose={onClose}
			size={PopoverSize.Small}
			bodyPadding={PopoverBodyPadding.Comfortable}
			footer={
				<div className="cal-detail__footer">
					<button type="button" className="bs-btn bs-btn--secondary" onClick={onClose}>
						{t("calendar.bulk.cancel")}
					</button>
					<span className="cal-detail__footer-spacer" />
					<button type="button" className="bs-btn" data-bs-primary="" onClick={move}>
						{t("calendar.bulk.move")}
					</button>
				</div>
			}
		>
			<div className="cal-bulk">
				<DateTimeField labelKey="calendar.bulk.dateLabel" value={value} allDay onChange={setValue} />
			</div>
		</Popover>
	);
}
