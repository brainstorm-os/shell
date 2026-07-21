/**
 * `@brainstorm-os/sdk/calendar` — shared month-grid + mini-calendar
 * primitives. Used by every app with a calendar surface (Calendar app
 * month/sidebar, Database calendar view month + year tiles, Tasks date
 * popover). Visual style ships in `./calendar.css`, loaded through the
 * `app-theme.css` aggregator (per
 * `[[project_workspace_css_subpath_export]]` — side-effect imports get
 * tree-shaken under `sideEffects: false`).
 */

export {
	createMonthGrid,
	MonthGridDensity,
	type MonthGridCell,
	type MonthGridHandle,
	type MonthGridOptions,
} from "./month-grid";

export { MonthGrid, type MonthGridProps, type MonthGridReactCell } from "./MonthGrid";

export {
	createMiniCalendar,
	type MiniCalendarHandle,
	type MiniCalendarLabels,
	type MiniCalendarOptions,
} from "./mini-calendar";

export { MiniCalendar, type MiniCalendarProps } from "./MiniCalendar";

export {
	openCalendarPopover,
	closeCalendarPopover,
	type CalendarPopoverAnchor,
	type CalendarPopoverHandle,
	type CalendarPopoverOptions,
} from "./calendar-popover";
