/**
 * Calendar-app translate function. Wraps the shared
 * `createT` from `@brainstorm/sdk/i18n` (the one app-side `t()` — no
 * per-app re-implementation of the lookup / `{param}` interpolation /
 * missing-key behaviour) over a default-English manifest. A localised
 * build passes overrides via `createT(MANIFEST, overrides)`.
 */

import { createT, plural as sdkPlural } from "@brainstorm/sdk/i18n";

export const MANIFEST = {
	// App chrome
	"calendar.app.title": "Calendar",
	"calendar.app.icon.alt": "Calendar",
	"calendar.chrome.resizeSidebar": "Resize sidebar",

	// Dashboard widget (Stage 7.3a). Title / open chrome is drawn by the shell's
	// widget strip; the app supplies the body — today's agenda glance list.
	"calendar.widget.today.label": "Today",
	"calendar.widget.empty": "Nothing scheduled today",
	"calendar.widget.count.one": "{count} event",
	"calendar.widget.count.other": "{count} events",
	// "Week ahead" widget (large) — the next 7 days, grouped by day.
	"calendar.widget.week.label": "Week ahead",
	"calendar.widget.week.empty": "Nothing scheduled this week",

	// View-kind labels
	"calendar.view.year": "Year",
	"calendar.view.month": "Month",
	"calendar.view.week": "Week",
	"calendar.view.day": "Day",
	"calendar.view.agenda": "Agenda",
	// Year view (9.15.11)
	"calendar.year.openMonth": "Open {month}",
	"calendar.year.dayLabel": "{date}: {count} items",
	// Event search (9.15.12)
	"calendar.search.button": "Search events",
	"calendar.search.title": "Search events",
	"calendar.search.placeholder": "Search by title or location…",
	"calendar.search.hint": "Type to search your calendar.",
	"calendar.search.empty": "No matching events.",
	// Multi-select + bulk reschedule (9.15.15)
	"calendar.selection.count": "{count} selected",
	"calendar.selection.reschedule": "Reschedule…",
	"calendar.selection.clear": "Clear",
	"calendar.bulk.title": "Move {count} events",
	"calendar.bulk.dateLabel": "Move to",
	"calendar.bulk.move": "Move",
	"calendar.bulk.cancel": "Cancel",

	// Sidebar
	"calendar.sidebar.region": "Sidebar",
	"calendar.sidebar.miniMonth.prev": "Previous month",
	"calendar.sidebar.miniMonth.next": "Next month",
	"calendar.sidebar.calendarsHeading": "Calendars",
	"calendar.sidebar.calendars.empty": "No dated items yet.",
	"calendar.sidebar.calendar.events": "Events",
	"calendar.sidebar.calendar.journal": "Journal",

	// Header
	"calendar.header.prev": "Previous",
	"calendar.header.next": "Next",
	"calendar.header.today": "Today",
	"calendar.header.newEvent": "New event",
	"calendar.header.rangeLabel": "{range}",
	"calendar.header.sidebar.show": "Show sidebar",
	"calendar.header.sidebar.hide": "Hide sidebar",

	// Day-of-week labels (Mon–Sun)
	"calendar.weekday.short.mon": "Mon",
	"calendar.weekday.short.tue": "Tue",
	"calendar.weekday.short.wed": "Wed",
	"calendar.weekday.short.thu": "Thu",
	"calendar.weekday.short.fri": "Fri",
	"calendar.weekday.short.sat": "Sat",
	"calendar.weekday.short.sun": "Sun",

	// Item titles built in code (no string-built possessive in code —
	// the possessive grammar belongs in the localised template).
	"calendar.item.birthday": "{name}'s birthday",
	"calendar.item.journal": "Journal",
	"calendar.item.untitled": "Untitled",

	// Hour slot (week / day grid)
	"calendar.slot.create": "Create an event at {time}",

	// Event chip / row
	"calendar.event.allDay": "All day",
	"calendar.event.overflow": "+{count} more",
	"calendar.event.overflowPopover.title": "{count} items on this day",
	"calendar.event.moreActions": "More actions",
	// Object-menu destructive row — deletes the underlying entity (the owned
	// event, or the source Task / Note / Journal entry). Birthdays are derived
	// from a Contact's anniversary, so they get no Delete here.
	"calendar.menu.delete": "Delete",
	// Inline-event BP block insert (9.15.3) — copy the event as a
	// `brainstorm://entity/…` ref so a document can embed it as a live block.
	"calendar.event.copyBlockRef": "Copy as block",
	"calendar.event.copyBlockRef.done": "Event link copied — paste it into a document",
	// Recurrence summary (feeds the shared summarizeRecurrence keystone)
	"calendar.recurrence.daily": "Every day",
	"calendar.recurrence.everyNDays": "Every {n} days",
	"calendar.recurrence.weeklyOn": "Weekly on {days}",
	"calendar.recurrence.everyNWeeksOn": "Every {n} weeks on {days}",
	"calendar.recurrence.monthlyOnDay": "Monthly on day {day}",
	"calendar.recurrence.everyNMonthsOnDay": "Every {n} months on day {day}",
	"calendar.recurrence.monthlyOnWeekday": "Monthly on the {ordinal} {weekday}",
	"calendar.recurrence.everyNMonthsOnWeekday": "Every {n} months on the {ordinal} {weekday}",
	"calendar.recurrence.yearlyOn": "Yearly on {month} {day}",
	"calendar.recurrence.custom": "Custom recurrence",
	"calendar.recurrence.none": "Does not repeat",
	// Recurrence editor (9.15.13)
	"calendar.detail.field.repeat": "Repeat",
	"calendar.recurrence.kind.none": "Does not repeat",
	"calendar.recurrence.kind.daily": "Daily",
	"calendar.recurrence.kind.weekly": "Weekly",
	"calendar.recurrence.kind.monthly": "Monthly",
	"calendar.recurrence.kind.yearly": "Yearly",
	"calendar.recurrence.kind.custom": "Custom…",
	"calendar.recurrence.editEvery": "Every",
	"calendar.recurrence.unit.days": "days",
	"calendar.recurrence.unit.weeks": "weeks",
	"calendar.recurrence.unit.months": "months",
	"calendar.recurrence.intervalLabel": "Interval",
	"calendar.recurrence.onDays": "Repeat on",
	"calendar.recurrence.monthlyMode": "Monthly pattern",
	"calendar.recurrence.monthlyByDayLabel": "On day",
	"calendar.recurrence.monthlyByWeekdayLabel": "On the",
	"calendar.recurrence.yearlyMonth": "Month",
	"calendar.recurrence.yearlyDay": "Day",
	"calendar.recurrence.customLabel": "RRULE",
	"calendar.recurrence.customPlaceholder": "FREQ=WEEKLY;BYDAY=MO,WE,FR",
	"calendar.recurrence.summaryLabel": "Summary",
	"calendar.recurrence.ordinal.first": "first",
	"calendar.recurrence.ordinal.second": "second",
	"calendar.recurrence.ordinal.third": "third",
	"calendar.recurrence.ordinal.fourth": "fourth",
	"calendar.recurrence.ordinal.last": "last",
	"calendar.recurrence.listSeparator": ", ",

	// Agenda
	"calendar.agenda.heading.today": "Today",
	"calendar.agenda.heading.tomorrow": "Tomorrow",
	"calendar.agenda.heading.thisWeek": "This week",
	"calendar.agenda.heading.later": "Later",
	"calendar.agenda.empty.title": "Nothing on your agenda",
	"calendar.agenda.empty.body":
		"Events, scheduled tasks, and date properties land here once you have some.",

	// Empty states
	"calendar.empty.title": "Nothing scheduled in this range",
	"calendar.empty.body": "Try Today, or jump to a different month.",

	// Date formatting hints
	"calendar.date.today": "Today",
	"calendar.date.tomorrow": "Tomorrow",
	"calendar.date.yesterday": "Yesterday",

	// Event detail / create surface
	"calendar.detail.createTitle": "New event",
	"calendar.detail.editTitle": "Edit event",
	"calendar.detail.field.title": "Title",
	"calendar.detail.field.titlePlaceholder": "Event title",
	"calendar.detail.field.icon": "Icon",
	"calendar.detail.field.iconChoose": "Choose icon",
	"calendar.detail.field.start": "Starts",
	"calendar.detail.field.end": "Ends",
	"calendar.detail.field.pickDate": "Pick a date",
	"calendar.detail.field.pickTime": "Time",
	"calendar.detail.field.datePlaceholder": "Set date",
	"calendar.detail.field.prevMonth": "Previous month",
	"calendar.detail.field.nextMonth": "Next month",
	"calendar.detail.field.allDay": "All day",
	"calendar.detail.field.location": "Location",
	"calendar.detail.field.locationPlaceholder": "Add a location",
	"calendar.detail.field.description": "Description",
	"calendar.detail.field.descriptionPlaceholder": "Add notes about this event",
	"calendar.detail.more": "More options",
	"calendar.detail.field.status": "Status",
	"calendar.detail.field.color": "Colour",
	"calendar.detail.field.reminders": "Reminders",
	"calendar.detail.field.timeZone": "Time zone",
	"calendar.detail.tz.local": "Local time",
	"calendar.detail.tz.common": "Common",
	"calendar.reminder.atStart": "At start",
	"calendar.reminder.minutesBefore": "{n} min before",
	"calendar.reminder.hourBefore": "1 hour before",
	"calendar.reminder.dayBefore": "1 day before",
	"calendar.reminder.notify.title": "Upcoming: {title}",
	"calendar.reminder.notify.bodyAtStart": "Starting now",
	"calendar.reminder.notify.body": "Starts {label}",
	// Attendees / RSVP (9.15.17)
	"calendar.detail.field.attendees": "Attendees",
	"calendar.attendee.addNamePlaceholder": "Name",
	"calendar.attendee.addEmailPlaceholder": "email@example.com",
	"calendar.attendee.add": "Add attendee",
	"calendar.attendee.remove": "Remove {name}",
	"calendar.attendee.rsvpLabel": "Response for {name}",
	"calendar.attendee.rsvp.accepted": "Going",
	"calendar.attendee.rsvp.tentative": "Maybe",
	"calendar.attendee.rsvp.declined": "Not going",
	"calendar.attendee.rsvp.needsAction": "No response",
	"calendar.attendee.empty": "No attendees yet",
	"calendar.attendee.summary": "{accepted} going · {tentative} maybe · {declined} not going",
	"calendar.event.guests": "{count} guests",
	// ICS import / export (9.15.18)
	"calendar.actions.menu": "Calendar actions",
	"calendar.actions.import": "Import from iCal…",
	"calendar.actions.export": "Export to iCal…",
	"calendar.actions.saveDialogTitle": "Export calendar",
	"calendar.actions.openDialogTitle": "Import calendar",
	"calendar.ics.filterName": "iCalendar",
	"calendar.actions.imported": "Imported {count} events",
	"calendar.actions.importNone": "No events found in that file",
	"calendar.actions.exportEmpty": "No events to export",
	"calendar.actions.saved": "Calendar exported",
	"calendar.actions.exportFailed": "Export failed",
	"calendar.actions.importFailed": "Import failed",
	// CalDAV two-way sync (9.15.19)
	"calendar.actions.caldav": "CalDAV sync…",
	"calendar.caldav.title": "CalDAV sync",
	"calendar.caldav.connectHint":
		"Connect a CalDAV server (Fastmail, iCloud, Nextcloud…) with an app password. The password is stored in the vault keystore, never on an entity.",
	"calendar.caldav.serverUrl": "Server URL",
	"calendar.caldav.username": "Username",
	"calendar.caldav.password": "App password",
	"calendar.caldav.connect": "Connect",
	"calendar.caldav.connected": "CalDAV account connected",
	"calendar.caldav.disconnect": "Disconnect",
	"calendar.caldav.subscribed": "Synced calendars",
	"calendar.caldav.noneSubscribed": "No calendars synced yet — add one from the server below.",
	"calendar.caldav.onServer": "On the server",
	"calendar.caldav.loadCalendars": "Load calendars",
	"calendar.caldav.allSubscribed": "Every event calendar on the server is already synced.",
	"calendar.caldav.add": "Add",
	"calendar.caldav.syncNow": "Sync now",
	"calendar.caldav.syncDone": "Synced: {pulled} pulled, {pushed} pushed",
	"calendar.caldav.syncConflicts.one":
		"{count} conflict resolved server-side — redo the local edit.",
	"calendar.caldav.syncConflicts.other":
		"{count} conflicts resolved server-side — redo local edits.",
	"calendar.caldav.loadFailed": "Could not load CalDAV accounts",
	"calendar.status.confirmed": "Confirmed",
	"calendar.status.tentative": "Tentative",
	"calendar.status.cancelled": "Cancelled",
	"calendar.color.none": "Default",
	"calendar.color.choose": "Use the {color} colour",
	"calendar.color.graphite": "graphite",
	"calendar.color.blue": "blue",
	"calendar.color.purple": "purple",
	"calendar.color.teal": "teal",
	"calendar.color.green": "green",
	"calendar.color.amber": "amber",
	"calendar.color.red": "red",
	"calendar.color.pink": "pink",
	"calendar.detail.save": "Save event",
	"calendar.detail.cancel": "Cancel",
	"calendar.detail.delete": "Delete event",
	"calendar.detail.lock": "Lock event (read-only)",
	"calendar.detail.unlock": "Unlock event",
	"calendar.detail.validation.title": "Give the event a title.",
	"calendar.detail.validation.endBeforeStart": "End must be after the start.",
} as const;

export type CalendarManifest = typeof MANIFEST;

/** A valid manifest key — use this for the type of any record whose
 *  values are passed to `t()` (view-label maps, agenda heading keys). */
export type TKey = keyof CalendarManifest;

export const t = createT(MANIFEST);

/** Catalog-bound plural — the ONE sanctioned `count === 1` selection
 *  (per CLAUDE.md app-side plural rule). */
export const plural = (count: number, one: TKey, other: TKey): string =>
	sdkPlural(t, count, one, other);

export type TranslationParams = Record<string, string | number>;
