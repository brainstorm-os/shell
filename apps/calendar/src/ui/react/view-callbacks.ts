/**
 * Shared callback + provider types passed from `<CalendarApp>` down into the
 * view components (Month / Week / Day / Agenda / Year). Kept in one module so
 * the views and the chip agree on the exact shapes.
 */

import type { ObjectDragPayload } from "@brainstorm-os/sdk-types";
import type { ObjectMenuContext } from "@brainstorm-os/sdk/object-menu";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { ScheduledItem } from "../../logic/scheduled-item";

/** Resolves the object-menu context for an item at open time. */
export type EventChipMenuProvider = (item: ScheduledItem) => ObjectMenuContext;

/** Reschedule callback — fired when a chip/block is dropped on a new instant. */
export type RescheduleHandler = (item: ScheduledItem, newStart: number) => void;

/** Cross-app object drop onto a day (DND-4) — set the dropped object(s)' date
 *  property to `dayStart` (local midnight of the target cell). */
export type ObjectDropHandler = (dayStart: number, payload: ObjectDragPayload) => void;

export type ViewCallbacks = {
	onItemClick(item: ScheduledItem, event?: ReactMouseEvent): void;
	onDayClick(dayStart: number): void;
	/** Click empty space in a grid cell / hour slot to compose at that day/hour. */
	onEmptyCellClick(startMs: number): void;
	onMonthOpen(monthStart: number): void;
	objectMenu: EventChipMenuProvider;
	onReschedule: RescheduleHandler;
	/** Drop an object dragged from another app onto a day (sets its date).
	 *  Absent in standalone / demo mode (no entities service). */
	onDropObject?: ObjectDropHandler;
};
