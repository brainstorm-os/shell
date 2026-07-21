/**
 * Calendar header content (React) — the app lives in the single shell
 * `.app-header` bar: the **lead** group (back/forward nav + today/prev/next
 * pager + range title) in `.app-header__left`, and the **actions** group
 * (view-kind tabs + search + New event), then the sidebar toggle + ICS ⋯, in
 * `.app-header__right`. Title-in-the-header matches every other app.
 */

import { Orientation, SelectionAttribute, useCompositeKeyboard } from "@brainstorm-os/sdk/a11y";
import { DatePager } from "@brainstorm-os/sdk/date-pager";
import { Icon, IconName } from "@brainstorm-os/sdk/icon";
import { useState } from "react";
import { type TKey, t } from "../../i18n/t";
import {
	CALENDAR_VIEW_KINDS,
	CalendarViewKind,
	type WeekStartsOn,
} from "../../types/calendar-view";
import { formatRangeLabel } from "../format-date";

const VIEW_LABEL_KEY: Record<CalendarViewKind, TKey> = {
	[CalendarViewKind.Year]: "calendar.view.year",
	[CalendarViewKind.Month]: "calendar.view.month",
	[CalendarViewKind.Week]: "calendar.view.week",
	[CalendarViewKind.Day]: "calendar.view.day",
	[CalendarViewKind.Agenda]: "calendar.view.agenda",
};

export type CalendarHeaderProps = {
	viewKind: CalendarViewKind;
	anchor: number;
	weekStartsOn: WeekStartsOn;
	onPrev(): void;
	onNext(): void;
	onToday(): void;
	onViewKind(kind: CalendarViewKind): void;
	onNewEvent(): void;
	onSearch(): void;
};

export function CalendarHeaderLead({
	viewKind,
	anchor,
	weekStartsOn,
	onPrev,
	onNext,
	onToday,
}: Pick<
	CalendarHeaderProps,
	"viewKind" | "anchor" | "weekStartsOn" | "onPrev" | "onNext" | "onToday"
>) {
	return (
		<div className="cal-header__lead">
			<DatePager
				labels={{
					today: t("calendar.header.today"),
					prev: t("calendar.header.prev"),
					next: t("calendar.header.next"),
				}}
				onToday={onToday}
				onPrev={onPrev}
				onNext={onNext}
				className="cal-toolbar__nav"
			/>
			<h1 className="app-header__title cal-toolbar__range">
				{formatRangeLabel(viewKind, anchor, weekStartsOn)}
			</h1>
		</div>
	);
}

export function CalendarHeaderActions({
	viewKind,
	onViewKind,
	onNewEvent,
	onSearch,
}: Pick<CalendarHeaderProps, "viewKind" | "onViewKind" | "onNewEvent" | "onSearch">) {
	// View-tabs are a segmented control; search + New are individual icon
	// buttons that belong on the same rhythm as the sibling sidebar-toggle /
	// ⋯ buttons in `.app-header__right`, so they sit there directly (no
	// wrapping group) and inherit the right-group gap.
	return (
		<>
			<button
				type="button"
				className="cal-toolbar__new"
				data-bs-tooltip={t("calendar.header.newEvent")}
				aria-label={t("calendar.header.newEvent")}
				onClick={onNewEvent}
			>
				<Icon name={IconName.Plus} size={18} />
			</button>
			<ViewTabs viewKind={viewKind} onViewKind={onViewKind} />
			<button
				type="button"
				className="cal-toolbar__search"
				data-bs-tooltip={t("calendar.search.button")}
				aria-label={t("calendar.search.button")}
				onClick={onSearch}
			>
				<Icon name={IconName.Search} size={18} />
			</button>
		</>
	);
}

function ViewTabs({ viewKind, onViewKind }: Pick<CalendarHeaderProps, "viewKind" | "onViewKind">) {
	// KBN-A-calendar: roving cursor across the view tabs (the shared composite
	// binding owns tablist/tab roles + roving tabindex). The cursor starts on
	// the active view; selection (aria-selected) reflects the active view kind,
	// owned here — the cursor only moves focus, Enter / click commits.
	const initial = Math.max(0, CALENDAR_VIEW_KINDS.indexOf(viewKind));
	const [cursor, setCursor] = useState(initial);

	const { containerProps, getItemProps } = useCompositeKeyboard({
		orientation: Orientation.Horizontal,
		role: "tablist",
		itemRole: "tab",
		selectionAttribute: SelectionAttribute.None,
		count: CALENDAR_VIEW_KINDS.length,
		activeIndex: cursor,
		onActiveIndexChange: setCursor,
		onActivate: (i) => {
			const kind = CALENDAR_VIEW_KINDS[i];
			if (kind) onViewKind(kind);
		},
	});

	return (
		<div className="cal-toolbar__tabs" {...containerProps}>
			{CALENDAR_VIEW_KINDS.map((kind, index) => (
				<button
					key={kind}
					type="button"
					className="cal-toolbar__tab"
					data-view={kind}
					aria-selected={viewKind === kind}
					onClick={() => onViewKind(kind)}
					{...getItemProps(index)}
				>
					{t(VIEW_LABEL_KEY[kind])}
				</button>
			))}
		</div>
	);
}
