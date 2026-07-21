/**
 * Sidebar (React) — left navigation pane: the shared `<MiniCalendar>` (with
 * anchor-aware highlight) and the source-calendar filter toggles. The toggle
 * list is *discovered* from what's in the vault (9.15f) — one row per
 * `(entity type · date property)` plus the built-in Events / Journal sources —
 * not a hardcoded enum. View-kind switching lives in the header only.
 */

import { MiniCalendar } from "@brainstorm-os/sdk/calendar";
import { t } from "../../i18n/t";
import type { CalendarSource } from "../../logic/calendar-sources";
import type { WeekStartsOn } from "../../types/calendar-view";
import { weekdayHeaderLabels } from "../format-date";

export type SidebarProps = {
	anchor: number;
	now: number;
	weekStartsOn: WeekStartsOn;
	sources: readonly CalendarSource[];
	hiddenSources: ReadonlySet<string>;
	onAnchor(epochMs: number): void;
	onToggleSource(key: string): void;
};

export function Sidebar({
	anchor,
	now,
	weekStartsOn,
	sources,
	hiddenSources,
	onAnchor,
	onToggleSource,
}: SidebarProps) {
	const narrowLabels = weekdayHeaderLabels(weekStartsOn).map((l) => l.charAt(0));
	return (
		<aside className="cal-sidebar" aria-label={t("calendar.sidebar.region")}>
			<MiniCalendar
				labels={{
					today: t("calendar.date.today"),
					prev: t("calendar.sidebar.miniMonth.prev"),
					next: t("calendar.sidebar.miniMonth.next"),
				}}
				valueMs={anchor}
				viewMs={anchor}
				todayMs={now}
				weekStartsOn={weekStartsOn}
				weekdayLabels={narrowLabels}
				onChange={(ms) => onAnchor(ms)}
				onViewChange={(ms) => onAnchor(ms)}
			/>
			<section className="cal-sidebar__group">
				<h2 className="cal-sidebar__heading">{t("calendar.sidebar.calendarsHeading")}</h2>
				{sources.length === 0 ? (
					<p className="cal-sidebar__empty">{t("calendar.sidebar.calendars.empty")}</p>
				) : (
					<ul className="cal-sidebar__list">
						{sources.map((source) => {
							const isVisible = !hiddenSources.has(source.key);
							return (
								<li key={source.key} className="cal-sidebar__item">
									<button
										type="button"
										className="cal-sidebar__row cal-sidebar__row--source"
										aria-pressed={isVisible}
										data-source={source.key}
										onClick={() => onToggleSource(source.key)}
									>
										<span className="cal-sidebar__dot" style={{ ["--dot-color" as string]: source.color }} />
										<span className="cal-sidebar__label">{source.label}</span>
										<span className="cal-sidebar__count" aria-hidden="true">
											{source.count}
										</span>
										<span className="cal-sidebar__check" aria-hidden="true">
											{isVisible ? "✓" : ""}
										</span>
									</button>
								</li>
							);
						})}
					</ul>
				)}
			</section>
		</aside>
	);
}
