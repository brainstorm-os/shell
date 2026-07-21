/**
 * `@brainstorm-os/sdk/date-pager` — the shared "today + prev + next" cluster
 * used by every app with a date axis (Calendar header, Database
 * calendar-view toolbar, Journal day-strip). See `./date-pager.ts` for
 * the rationale; CSS rides through `app-theme.css`.
 */

export {
	createDatePager,
	type DatePagerHandle,
	type DatePagerLabels,
	type DatePagerOptions,
} from "./date-pager";

export { DatePager, type DatePagerProps } from "./DatePager";
