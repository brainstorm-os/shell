/**
 * The anchor date to adopt when switching the Calendar to a new view.
 *
 * Day / Week snap to their period start so prev/next steps land cleanly.
 * Month / Year / Agenda **keep** the current anchor.
 *
 * The Year case is the important one: it used to collapse the anchor to
 * Jan 1 (`startOfYear`), which silently threw away which month you were on
 * — so switching Year → Month landed you on January even though you'd been
 * in July (dogfood 912/912b). The Year view derives its Jan→Dec grid from
 * `getFullYear(anchor)` (see `compileYearView`) and year nav steps by
 * ±12 months, so it never needed a Jan-1 anchor. Keeping the anchor
 * preserves the month across the round-trip.
 */

import { CalendarViewKind, type WeekStartsOn } from "../types/calendar-view";
import { startOfDay, startOfWeek } from "./date-range";

export function viewSwitchAnchor(
	kind: CalendarViewKind,
	cur: number,
	weekStartsOn: WeekStartsOn,
): number {
	switch (kind) {
		case CalendarViewKind.Day:
			return startOfDay(cur);
		case CalendarViewKind.Week:
			return startOfWeek(cur, weekStartsOn);
		default:
			// Month / Year / Agenda keep the anchor — no month-losing collapse.
			return cur;
	}
}
