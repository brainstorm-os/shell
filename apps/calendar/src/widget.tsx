/**
 * Calendar dashboard widget (Stage 7.3 / 7.3a). When Calendar is launched as a
 * dashboard widget (`launch.reason === "widget"`), `main.tsx` mounts this
 * instead of the full app — the same bundle, in widget-mode. The one registered
 * widget, `today-agenda`, is a glance list of TODAY's events (earliest first);
 * the shell strip above draws the title / open / collapse / ⋯ chrome, and
 * clicking a row opens that event in the full Calendar app.
 */

import { useVaultEntities } from "@brainstorm/react-yjs";
import { openEntity } from "@brainstorm/sdk";
import {
	WidgetEmpty,
	type WidgetLaunch,
	WidgetRoot,
	useWidgetVisible,
} from "@brainstorm/sdk/widget";
import { useMemo } from "react";
import { plural, t } from "./i18n/t";
import { addDays, startOfDay } from "./logic/date-range";
import { getCalendarRuntime } from "./runtime";
import { EVENT_TYPE } from "./storage/entities-repository";
import { formatGroupDateLabel, formatTime } from "./ui/format-date";
import "./widget.css";

/** Manifest widget ids — must match `registrations.widgets[].id` in manifest.json. */
export const CALENDAR_WIDGET_TODAY_AGENDA = "today-agenda";
export const CALENDAR_WIDGET_WEEK_AHEAD = "week-ahead";

const AGENDA_LIMIT = 8;

/** Server-side narrowing for the widget's entity subscription (F-384) —
 *  module-level so the reference is stable across renders. */
const WIDGET_QUERY = { types: [EVENT_TYPE] } as const;

/** Empty-state CTA (F-381): an entityType-only `open` routes to the type's
 *  registered opener and launches the full Calendar app. */
function openCalendarApp(): void {
	const intents = getCalendarRuntime()?.services?.intents;
	if (!intents) return;
	void intents.dispatch({ verb: "open", payload: { entityType: EVENT_TYPE } });
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** How many days the large "Week ahead" widget spans (today + the next 6). */
const WEEK_DAYS = 7;

type AgendaRow = { id: string; title: string; start: number; allDay: boolean };

/** A day's worth of upcoming events — `key` is the local day-start (sortable +
 *  the formatter anchor for the header label). */
type DayGroup = { key: number; events: AgendaRow[] };

function eventTitle(properties: Record<string, unknown>): string {
	const title = properties.title;
	return typeof title === "string" && title.trim().length > 0 ? title : t("calendar.item.untitled");
}

/** The `start` property is an epoch-ms instant (see `types/event.ts`); guard the
 *  read since the property bag crosses a structured-clone boundary untyped. */
function eventStart(properties: Record<string, unknown>): number | null {
	const start = properties.start;
	return typeof start === "number" && Number.isFinite(start) ? start : null;
}

function TodayAgenda({ rows, total }: { rows: AgendaRow[]; total: number }) {
	const runtime = getCalendarRuntime();
	return (
		<div className="calendar-widget">
			<div className="calendar-widget__toolbar">
				<span className="calendar-widget__label">{t("calendar.widget.today.label")}</span>
				<span className="calendar-widget__count">
					{plural(total, "calendar.widget.count.one", "calendar.widget.count.other")}
				</span>
			</div>
			{rows.length === 0 ? (
				<WidgetEmpty
					message={t("calendar.widget.empty")}
					actionLabel={t("calendar.widget.emptyAction")}
					onAction={openCalendarApp}
				/>
			) : (
				<ul className="calendar-widget__list">
					{rows.map((row) => (
						<li key={row.id}>
							<button
								type="button"
								className="calendar-widget__row"
								onClick={() => void openEntity(runtime, { entityId: row.id, entityType: EVENT_TYPE })}
							>
								<span className="calendar-widget__time">
									{row.allDay ? t("calendar.event.allDay") : formatTime(row.start)}
								</span>
								<span className="calendar-widget__title">{row.title}</span>
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

/** Group the upcoming events into day buckets across the next `days` days
 *  (today inclusive). Pure (takes `now`) so it unit-tests without a clock;
 *  buckets are day-ascending, events within a day all-day-first then by start. */
export function computeWeekAhead(
	events: readonly AgendaRow[],
	now: number,
	days = WEEK_DAYS,
): DayGroup[] {
	const windowStart = startOfDay(now);
	const windowEnd = addDays(windowStart, days);
	const byDay = new Map<number, AgendaRow[]>();
	for (const event of events) {
		if (event.start < windowStart || event.start >= windowEnd) continue;
		const dayKey = startOfDay(event.start);
		const bucket = byDay.get(dayKey);
		if (bucket) bucket.push(event);
		else byDay.set(dayKey, [event]);
	}
	return [...byDay.entries()]
		.sort(([a], [b]) => a - b)
		.map(([key, rows]) => ({
			key,
			events: rows.sort((a, b) => {
				if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
				return a.start - b.start;
			}),
		}));
}

function WeekAhead({ groups, total, now }: { groups: DayGroup[]; total: number; now: number }) {
	const runtime = getCalendarRuntime();
	return (
		<div className="calendar-widget calendar-widget--week">
			<div className="calendar-widget__toolbar">
				<span className="calendar-widget__label">{t("calendar.widget.week.label")}</span>
				<span className="calendar-widget__count">
					{plural(total, "calendar.widget.count.one", "calendar.widget.count.other")}
				</span>
			</div>
			{groups.length === 0 ? (
				<WidgetEmpty
					message={t("calendar.widget.week.empty")}
					actionLabel={t("calendar.widget.emptyAction")}
					onAction={openCalendarApp}
				/>
			) : (
				<div className="calendar-widget__week">
					{groups.map((group) => (
						<section key={group.key} className="calendar-widget__day">
							<h3 className="calendar-widget__day-label">{formatGroupDateLabel(group.key, now)}</h3>
							<ul className="calendar-widget__list">
								{group.events.map((row) => (
									<li key={row.id}>
										<button
											type="button"
											className="calendar-widget__row"
											onClick={() => void openEntity(runtime, { entityId: row.id, entityType: EVENT_TYPE })}
										>
											<span className="calendar-widget__time">
												{row.allDay ? t("calendar.event.allDay") : formatTime(row.start)}
											</span>
											<span className="calendar-widget__title">{row.title}</span>
										</button>
									</li>
								))}
							</ul>
						</section>
					))}
				</div>
			)}
		</div>
	);
}

export function CalendarWidget({ launch }: { launch: WidgetLaunch }) {
	const runtime = getCalendarRuntime();
	// Reactive over the shell's live vault-entity index — pauses implicitly when
	// the host scrolls the widget off-screen (the surface stops re-rendering).
	useWidgetVisible();
	const { entities } = useVaultEntities(runtime?.services?.vaultEntities ?? null, {
		query: WIDGET_QUERY,
	});

	// Normalise every live event once (id / title / start / all-day), shared by
	// both the today-agenda and week-ahead widgets so neither re-walks entities.
	const events = useMemo<AgendaRow[]>(() => {
		const out: AgendaRow[] = [];
		for (const entity of entities) {
			if (entity.type !== EVENT_TYPE || entity.deletedAt !== null) continue;
			const start = eventStart(entity.properties);
			if (start === null) continue;
			out.push({
				id: entity.id,
				title: eventTitle(entity.properties),
				start,
				allDay: entity.properties.allDay === true,
			});
		}
		return out;
	}, [entities]);

	const { rows, total } = useMemo(() => {
		// "Today" = the local calendar day containing now (DST-safe via the shared
		// startOfDay helper). App runtime code, so Date.now() is fine here.
		const dayStart = startOfDay(Date.now());
		const dayEnd = dayStart + DAY_MS;
		const today = events
			.filter((e) => e.start >= dayStart && e.start < dayEnd)
			.sort((a, b) => a.start - b.start);
		return { rows: today.slice(0, AGENDA_LIMIT), total: today.length };
	}, [events]);

	// Recompute the week against `now` only when the event set changes — the
	// anchor is captured once per derivation (no per-render clock churn).
	const week = useMemo(() => {
		const now = Date.now();
		const groups = computeWeekAhead(events, now);
		const total = groups.reduce((sum, g) => sum + g.events.length, 0);
		return { groups, total, now };
	}, [events]);

	return (
		<WidgetRoot
			widgets={[
				{
					id: CALENDAR_WIDGET_TODAY_AGENDA,
					render: () => <TodayAgenda rows={rows} total={total} />,
				},
				{
					id: CALENDAR_WIDGET_WEEK_AHEAD,
					render: () => <WeekAhead groups={week.groups} total={week.total} now={week.now} />,
				},
			]}
			launch={launch}
		/>
	);
}
