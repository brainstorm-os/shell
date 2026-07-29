/**
 * React event-chip — the single reusable chip used by Month / Week / Day /
 * Agenda views. Three modes:
 *   - `compact` (Month cell): small pill with start time + title.
 *   - `block` (Week/Day timed gutter): rectangle laid out via inline
 *      `top` + `height` style (the host owns positioning).
 *   - `row` (Agenda): single row with time + title + meta.
 *
 * React twin of the imperative `renderEventChip`: same `.cal-chip*` classes,
 * same `--chip-color`, same `data-*` attributes, same object-menu trigger
 * (right-click on the chip + an in-chip `.cal-chip__more` ⋯, both opening the
 * shared `openObjectMenu` popup).
 */

import { summarizeRecurrence } from "@brainstorm-os/sdk-types";
import { openObjectMenu } from "@brainstorm-os/sdk/object-menu";
import type { CSSProperties, MouseEvent as ReactMouseEvent, Ref } from "react";
import { useCallback } from "react";
import { recurrenceLabels } from "../../i18n/recurrence-labels";
import { t } from "../../i18n/t";
import { type ScheduledItem, colorForItem } from "../../logic/scheduled-item";
import { localTimeZone, tzShortName } from "../../logic/timezone";
import { formatTime, formatTimeRange } from "../format-date";
import { EntityIcon } from "./entity-icon";
import { MoreButton } from "./more-button";
import type { EventChipMenuProvider } from "./view-callbacks";

const LOCAL_TZ = localTimeZone();
const RECURRENCE_LABELS = recurrenceLabels();

export type EventChipMode = "compact" | "block" | "row";

/** Block-chip content gating band (`data-density`). Each band names the
 *  content that FITS the chip's inline height — the CSS hides the rest so
 *  meta lines never flex-shrink into mid-glyph clipping (dark-sweep
 *  2026-07-29: a 1h chip squeezed its time line to ascender tips because
 *  guests/tz lines were never gated). Bands are picked from the event's
 *  duration in `week-view.tsx`. */
export enum ChipDensity {
	/** <35min — title only. */
	Tight = "tight",
	/** 35–55min — title + time. */
	Compact = "compact",
	/** 55–80min — title + time + location. */
	Roomy = "roomy",
	/** ≥80min — full content (adds guests + timezone). */
	Spacious = "spacious",
}

/** Pick the band for a block chip of `durationMins`. Bands must match the
 *  pixel budget (64px/h ≈ 1.07px/min): every band's content has to FIT its
 *  minimum chip height, or the flex column squeezes the meta lines into
 *  mid-glyph clipping. */
export function densityForDuration(durationMins: number): ChipDensity {
	if (durationMins < 35) return ChipDensity.Tight;
	if (durationMins < 55) return ChipDensity.Compact;
	if (durationMins < 80) return ChipDensity.Roomy;
	return ChipDensity.Spacious;
}

export type EventChipProps = {
	item: ScheduledItem;
	mode: EventChipMode;
	onClick?: (item: ScheduledItem, event?: ReactMouseEvent) => void;
	objectMenu?: EventChipMenuProvider;
	/** Inline style (block-mode positioning + density). */
	style?: CSSProperties;
	/** Density hint (block mode) → `data-density`. */
	density?: ChipDensity;
	/** Forwarded to the chip button (drag wiring in week/month views). */
	buttonRef?: Ref<HTMLButtonElement>;
};

function ZoneBadge({ item }: { item: ScheduledItem }) {
	if (!item.timeZone || item.timeZone === LOCAL_TZ) return null;
	const name = tzShortName(item.start, item.timeZone);
	if (!name) return null;
	return <span className="cal-chip__meta cal-chip__meta--tz">{name}</span>;
}

function GuestsMeta({ item }: { item: ScheduledItem }) {
	if (!item.attendeeCount || item.attendeeCount <= 0) return null;
	return (
		<span className="cal-chip__meta cal-chip__meta--guests">
			{t("calendar.event.guests", { count: item.attendeeCount })}
		</span>
	);
}

function CompactBody({ item }: { item: ScheduledItem }) {
	return (
		<>
			{item.icon ? <EntityIcon icon={item.icon} size={13} className="cal-chip__icon" /> : null}
			{!item.allDay ? <span className="cal-chip__time">{formatTime(item.start)}</span> : null}
			<span className="cal-chip__title">{item.title}</span>
		</>
	);
}

function BlockBody({ item }: { item: ScheduledItem }) {
	return (
		<>
			<span className="cal-chip__title-row">
				{item.icon ? <EntityIcon icon={item.icon} size={14} className="cal-chip__icon" /> : null}
				<span className="cal-chip__title">{item.title}</span>
			</span>
			<span className="cal-chip__meta">
				{item.allDay ? t("calendar.event.allDay") : formatTimeRange(item.start, item.end)}
			</span>
			{item.location ? (
				<span className="cal-chip__meta cal-chip__meta--location">{item.location}</span>
			) : null}
			<GuestsMeta item={item} />
			<ZoneBadge item={item} />
		</>
	);
}

function RowBody({ item }: { item: ScheduledItem }) {
	return (
		<>
			{item.icon ? (
				<EntityIcon icon={item.icon} size={16} className="cal-chip__icon" />
			) : (
				<span className="cal-chip__dot" />
			)}
			<span className="cal-chip__time">
				{item.allDay ? t("calendar.event.allDay") : formatTimeRange(item.start, item.end)}
			</span>
			<span className="cal-chip__title">{item.title}</span>
			{item.location ? (
				<span className="cal-chip__meta cal-chip__meta--location">{item.location}</span>
			) : null}
			<GuestsMeta item={item} />
			<ZoneBadge item={item} />
		</>
	);
}

export function EventChip({
	item,
	mode,
	onClick,
	objectMenu,
	style,
	density,
	buttonRef,
}: EventChipProps) {
	const chipStyle: CSSProperties = {
		...(style ?? {}),
		// The item's own colour wins; otherwise it wears its source's legend
		// colour (F-042). `--chip-color` is consumed by styles.css.
		["--chip-color" as string]: colorForItem(item),
	};
	const summary = item.recurrence ? summarizeRecurrence(item.recurrence, RECURRENCE_LABELS) : null;

	const onContextMenu = useCallback(
		(event: ReactMouseEvent) => {
			if (!objectMenu) return;
			const ctx = objectMenu(item);
			if (!ctx) return;
			event.preventDefault();
			void openObjectMenu({ x: event.clientX, y: event.clientY }, ctx);
		},
		[objectMenu, item],
	);

	return (
		<button
			ref={buttonRef}
			type="button"
			className={`cal-chip cal-chip--${mode}`}
			data-item-id={item.id}
			data-entity-id={item.sourceEntityId}
			data-source={item.sourceKey}
			style={chipStyle}
			{...(item.statusKey ? { "data-status": item.statusKey } : {})}
			{...(item.allDay ? { "data-all-day": "true" } : {})}
			{...(density !== undefined ? { "data-density": density } : {})}
			onClick={onClick ? (event) => onClick(item, event) : undefined}
			onContextMenu={objectMenu ? onContextMenu : undefined}
		>
			{mode === "compact" ? (
				<CompactBody item={item} />
			) : mode === "block" ? (
				<BlockBody item={item} />
			) : (
				<RowBody item={item} />
			)}
			{summary !== null ? (
				<span className="cal-chip__recurring" aria-label={summary} title={summary}>
					↻
				</span>
			) : null}
			{objectMenu ? (
				<MoreButton
					context={() => objectMenu(item)}
					label={t("calendar.event.moreActions")}
					className="cal-chip__more"
				/>
			) : null}
		</button>
	);
}
