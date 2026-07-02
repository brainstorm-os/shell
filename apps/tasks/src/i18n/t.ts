/**
 * Tasks-app translate function. Built on the shared `@brainstorm/sdk/i18n`
 * `createT` (the app-side `t()` per the shared-fundamentals contract §C) —
 * this module owns only the default-English manifest + a dev missing-key
 * warning + the tiny plural switch; the lookup/interpolation is the SDK's.
 * Per CLAUDE.md §Localization every user-visible string wraps in `t(key)`.
 */

import { createT } from "@brainstorm/sdk/i18n";

const DEFAULTS = {
	// App chrome
	"tasks.app.title": "Tasks",
	"tasks.app.icon.alt": "Tasks",

	// Dashboard widget (Stage 7.3a). Title / open chrome is drawn by the shell's
	// widget strip; the app supplies the body — empty-state copy + the in-widget
	// sort control + the open-task count.
	"tasks.widget.untitled": "Untitled task",
	"tasks.widget.empty": "No open tasks",
	"tasks.widget.sort.label": "Sort tasks",
	"tasks.widget.sort.updated": "Recently updated",
	"tasks.widget.sort.title": "Title (A–Z)",
	"tasks.widget.count.zero": "No open tasks",
	"tasks.widget.count.one": "{count} open task",
	"tasks.widget.count.other": "{count} open tasks",
	// "Task Stats" widget (small) — a glance count card: the open total plus an
	// overdue / due-today breakdown. Each stat opens its most-urgent task.
	"tasks.widget.stats.open": "Open",
	"tasks.widget.stats.overdue": "Overdue",
	"tasks.widget.stats.dueToday": "Due today",
	"tasks.widget.stats.empty": "No tasks yet",

	// Sidebar — built-in surfaces
	"tasks.surface.inbox": "Inbox",
	"tasks.surface.today": "Today",
	"tasks.surface.upcoming": "Upcoming",
	"tasks.surface.board": "Board",
	"tasks.surface.timeline": "Timeline",
	"tasks.surface.project": "Project",

	// Status board (9.14.10)
	"tasks.board.region": "Status board",
	"tasks.board.empty": "No tasks",
	"tasks.board.addTask": "+ New task",
	"tasks.board.addPlaceholder": "New task…",

	// Timeline / Gantt (9.14.11)
	"tasks.timeline.region": "Timeline",
	"tasks.timeline.empty": "Nothing scheduled — give a task a date and it appears here",
	"tasks.timeline.bar.dates": "{start} to {end}",
	"tasks.timeline.unscheduled.zero": "No unscheduled tasks",
	"tasks.timeline.unscheduled.one": "1 unscheduled task not shown",
	"tasks.timeline.unscheduled.other": "{count} unscheduled tasks not shown",
	// Timeline toolbar — density (zoom) picker + "Today" jump.
	"tasks.timeline.today": "Today",
	"tasks.timeline.today.scroll": "Scroll to today",
	"tasks.timeline.zoom.label": "Density: {level}",
	"tasks.timeline.zoom.menuLabel": "Timeline density",
	"tasks.timeline.zoom.days": "Days",
	"tasks.timeline.zoom.weeks": "Weeks",
	"tasks.timeline.zoom.months": "Months",

	// Tags + tag filter (9.14.10)
	"tasks.tags.region": "Tags",
	"tasks.tags.heading": "Tags",
	"tasks.tags.remove": "Remove tag",
	"tasks.tags.addPlaceholder": "Add a tag…",
	"tasks.filter.tag": "Tag: {tag}",
	"tasks.filter.clear": "Clear filter",

	// Comments / activity (9.14.14)
	"tasks.comments.region": "Comments",
	"tasks.comments.heading": "Comments",
	"tasks.comments.addPlaceholder": "Add a comment…",
	"tasks.comments.post": "Comment",
	"tasks.comments.remove": "Delete comment",
	"tasks.sidebar.surfacesHeading": "Surfaces",
	"tasks.sidebar.projectsHeading": "Projects",
	"tasks.sidebar.newProject": "New project",
	"tasks.sidebar.renameProject": "Project name",
	"tasks.project.defaultName": "New project",
	"tasks.project.create.title": "New project",
	"tasks.project.create.nameLabel": "Name",
	"tasks.project.create.placeholder": "Project name",
	"tasks.project.create.submit": "Create",
	"tasks.sidebar.region": "Sidebar",
	"tasks.sidebar.collapsedHint": "Press F1 to focus the sidebar",
	"tasks.sidebar.dragHandle.aria": "Drag to reorder",
	"tasks.row.dragHandle.aria": "Drag to reorder task",

	// Surface headers / section titles
	"tasks.section.inbox": "Inbox",
	"tasks.section.today": "Today",
	"tasks.section.overdue": "Overdue · {count}",
	"tasks.section.date": "{date}",
	// Upcoming grouping (F-164) — section headings + the "Group by ▾" picker.
	"tasks.section.assignee": "{name}",
	"tasks.section.unassigned": "Unassigned",
	"tasks.assignee.unknown": "Unknown person",
	// The value-less trailing sections shared by the Priority / Project / Status
	// / Tags axes. (Resolved buckets carry their already-localized heading as a
	// literal `CompiledSection.title`, not a passthrough key.)
	"tasks.section.noProject": "No project",
	"tasks.section.noStatus": "No status",
	"tasks.section.noTags": "No tags",
	"tasks.section.unknownProject": "Unknown project",
	// "Group by ▾" header picker — caption + menu label + one row per axis.
	"tasks.header.groupBy": "Group by {axis}",
	"tasks.group.menuLabel": "Group tasks by",
	"tasks.group.date": "Date",
	"tasks.group.assignee": "Assignee",
	"tasks.group.priority": "Priority",
	"tasks.group.project": "Project",
	"tasks.group.status": "Status",
	"tasks.group.tags": "Tags",
	// "Sort ▾" header picker — present on every list surface. Caption + menu
	// label + one row per sort key.
	"tasks.header.sortBy": "Sort: {key}",
	"tasks.sort.menuLabel": "Sort tasks by",
	"tasks.sort.default": "Default order",
	"tasks.sort.priority": "Priority",
	"tasks.sort.due": "Due date",
	"tasks.sort.name": "Name",
	"tasks.sort.created": "Recently created",
	"tasks.section.project": "Tasks",
	"tasks.header.count.zero": "No tasks",
	"tasks.header.count.one": "1 task",
	"tasks.header.count.other": "{count} tasks",
	"tasks.header.showCompleted": "Show completed",
	"tasks.header.newTask": "New task",
	"tasks.header.lock": "Lock task (read-only)",
	"tasks.header.unlock": "Unlock task",
	"tasks.header.sidebar.show": "Show sidebar",
	"tasks.header.sidebar.hide": "Hide sidebar",
	"tasks.header.iconPicker.open": "Change project icon",
	"tasks.header.renameProject": "Rename project",

	// Task row
	"tasks.row.toggle.aria": "Toggle complete",
	"tasks.row.icon.aria": "Change icon",
	// The row date chip shows ONE visible format — the bare relative date —
	// whether the anchor is a due or a scheduled date (a "Due 27 Jun" chip
	// next to a bare "26 Jun" chip read as two different things). The
	// due/scheduled semantics live in the chip's tooltip + an sr-only text
	// span (NOT aria-label — ARIA prohibits naming a generic-role <span>,
	// so screen readers ignore it in browse mode).
	"tasks.row.due.sr": "Due {date}",
	"tasks.row.scheduled.sr": "Scheduled {date}",
	"tasks.row.name.editAria": "Rename task",
	"tasks.row.chip.priority.set": "Set priority",
	"tasks.row.chip.priority.aria": "Change priority",
	"tasks.row.chip.date.set": "Schedule",
	"tasks.row.chip.date.aria": "Change scheduled and due dates",
	"tasks.row.chip.project.set": "Inbox",
	"tasks.row.chip.project.aria": "Move to project",
	"tasks.row.chip.recurrence.aria": "Change recurrence",
	"tasks.row.chip.clear": "Clear",
	"tasks.row.menu.priorityLabel": "Priority",
	"tasks.row.menu.priority.current": "Current priority",
	"tasks.row.menu.projectLabel": "Project",
	"tasks.row.menu.project.inbox": "Inbox",
	"tasks.row.date.scheduled": "Scheduled",
	"tasks.row.date.due": "Due",
	"tasks.row.date.clear": "Clear dates",
	"tasks.row.date.apply": "Apply",
	"tasks.row.date.title": "Dates",
	"tasks.row.date.prevMonth": "Previous month",
	"tasks.row.date.nextMonth": "Next month",
	"tasks.row.date.clearOne": "Clear",
	"tasks.row.recurrence.none": "Does not repeat",
	// Assignee chip (9.14.15) — display name resolved from the entity-title
	// index; the fallback shows while the index is still loading.
	"tasks.row.assignee.title": "Assignee: {name}",
	"tasks.row.assignee.fallback": "Assigned",
	// Custom vault properties on the detail panel (9.14.16).
	"tasks.props.add": "Add property",
	"tasks.props.remove": "Remove {name}",

	// Due / scheduled alerts (9.14.9) — shell notifications via ui.notify.
	"tasks.alert.due.title": "Due: {name}",
	"tasks.alert.due.body": "This task's deadline has arrived.",
	"tasks.alert.scheduled.title": "Scheduled: {name}",
	"tasks.alert.scheduled.body": "You planned to work on this today.",

	// Recurrence summary (feeds the shared summarizeRecurrence keystone)
	"tasks.recurrence.daily": "Every day",
	"tasks.recurrence.everyNDays": "Every {n} days",
	"tasks.recurrence.weeklyOn": "Weekly on {days}",
	"tasks.recurrence.everyNWeeksOn": "Every {n} weeks on {days}",
	"tasks.recurrence.monthlyOnDay": "Monthly on day {day}",
	"tasks.recurrence.everyNMonthsOnDay": "Every {n} months on day {day}",
	"tasks.recurrence.monthlyOnWeekday": "Monthly on the {ordinal} {weekday}",
	"tasks.recurrence.everyNMonthsOnWeekday": "Every {n} months on the {ordinal} {weekday}",
	"tasks.recurrence.yearlyOn": "Yearly on {month} {day}",
	"tasks.recurrence.custom": "Custom recurrence",
	"tasks.recurrence.none": "Does not repeat",
	"tasks.recurrence.ordinal.first": "first",
	"tasks.recurrence.ordinal.second": "second",
	"tasks.recurrence.ordinal.third": "third",
	"tasks.recurrence.ordinal.fourth": "fourth",
	"tasks.recurrence.ordinal.last": "last",
	"tasks.recurrence.listSeparator": ", ",

	// Recurrence editor UI (9.14.12 — shared @brainstorm/sdk/recurrence-editor)
	"tasks.recurrence.field.repeat": "Repeat",
	"tasks.recurrence.kind.none": "Does not repeat",
	"tasks.recurrence.kind.daily": "Daily",
	"tasks.recurrence.kind.weekly": "Weekly",
	"tasks.recurrence.kind.monthly": "Monthly",
	"tasks.recurrence.kind.yearly": "Yearly",
	"tasks.recurrence.kind.custom": "Custom",
	"tasks.recurrence.editEvery": "Every",
	"tasks.recurrence.unit.days": "days",
	"tasks.recurrence.unit.weeks": "weeks",
	"tasks.recurrence.unit.months": "months",
	"tasks.recurrence.intervalLabel": "Repeat interval",
	"tasks.recurrence.onDays": "On days",
	"tasks.recurrence.monthlyMode": "Monthly repeat pattern",
	"tasks.recurrence.monthlyByDayLabel": "On day",
	"tasks.recurrence.monthlyByWeekdayLabel": "On the",
	"tasks.recurrence.yearlyMonth": "Month",
	"tasks.recurrence.yearlyDay": "Day",
	"tasks.recurrence.customLabel": "Custom rule (RRULE)",
	"tasks.recurrence.customPlaceholder": "FREQ=WEEKLY;INTERVAL=1",
	"tasks.recurrence.region": "Repeat",
	"tasks.recurrence.heading": "Repeat",

	// Time estimate / logged effort (9.14.13)
	"tasks.time.region": "Time",
	"tasks.time.heading": "Time",
	"tasks.time.estimate": "Estimate",
	"tasks.time.logged": "Logged",

	// Priority labels
	"tasks.priority.none": "No priority",
	"tasks.priority.low": "Low priority",
	"tasks.priority.medium": "Medium priority",
	"tasks.priority.high": "High priority",
	"tasks.priority.critical": "Critical priority",

	// Empty states
	"tasks.empty.inbox.title": "Inbox is empty",
	"tasks.empty.inbox.body":
		"Tasks without a project or scheduled date land here. Press N to add one.",
	"tasks.empty.today.title": "Nothing scheduled for today",
	"tasks.empty.today.body": "You're caught up. Take a moment — or check Upcoming for what's next.",
	"tasks.empty.upcoming.title": "Nothing upcoming",
	"tasks.empty.upcoming.body": "Tasks scheduled for a future date will appear here, grouped by day.",
	"tasks.empty.project.title": "No tasks in this project",
	"tasks.empty.project.body": "Press N to add the first one.",

	// Inline search (9.22.3)
	"tasks.search.placeholder": "Search tasks…",
	"tasks.search.clear": "Clear search",
	"tasks.search.title": "Search results",
	"tasks.search.empty.title": "No matching tasks",
	"tasks.search.empty.body": "Nothing matches “{query}”. Try a different word.",

	// Date formatting hints used by the date formatter
	"tasks.date.today": "Today",
	"tasks.date.tomorrow": "Tomorrow",
	"tasks.date.yesterday": "Yesterday",

	// Quick-look fact sheet (intent.quick-look / Cmd+L)
	"tasks.quickLook.title": "Quick look",
	"tasks.quickLook.field.project": "Project",
	"tasks.quickLook.field.priority": "Priority",
	"tasks.quickLook.field.due": "Due",
	"tasks.quickLook.field.scheduled": "Scheduled",
	"tasks.quickLook.field.recurrence": "Repeats",
	"tasks.quickLook.field.status": "Status",
	"tasks.quickLook.field.notes": "Notes",
	"tasks.quickLook.value.done": "Completed",
	"tasks.quickLook.value.open": "Open",
	"tasks.quickLook.value.none": "—",
	"tasks.quickLook.notFound": "That task is no longer available.",

	// Compose (intent.compose — the Notes /task slash path) and edit
	"tasks.compose.title": "New task",
	"tasks.compose.title.edit": "Edit task",
	"tasks.compose.name.label": "Task name",
	"tasks.compose.name.placeholder": "What needs doing?",
	"tasks.compose.priority.label": "Priority",
	"tasks.compose.scheduled.label": "Scheduled",
	"tasks.compose.due.label": "Due",
	"tasks.compose.date.empty": "Set date",
	"tasks.compose.date.clear": "Clear",
	"tasks.compose.notes.label": "Notes",
	"tasks.compose.notes.placeholder": "Add detail…",
	"tasks.compose.cancel": "Cancel",
	"tasks.compose.create": "Create task",
	"tasks.compose.save": "Save",
	"tasks.compose.duplicate.hint": "You already have an open task with this name.",
	"tasks.menu.edit": "Edit…",

	// Task detail route + properties inspector
	"tasks.detail.region": "Task",
	"tasks.detail.properties": "Properties",
	"tasks.prop.status": "Status",
	"tasks.prop.priority": "Priority",
	"tasks.prop.scheduled": "Scheduled",
	"tasks.prop.due": "Due",
	"tasks.prop.project": "Project",
	"tasks.prop.assignee": "Assignee",
	"tasks.prop.estimate": "Estimate",
	"tasks.prop.logged": "Logged",
	"tasks.prop.tags": "Tags",
	"tasks.prop.created": "Created",
	"tasks.prop.updated": "Updated",

	// Subtasks section (9.14.7)
	"tasks.subtasks.region": "Subtasks",
	"tasks.subtasks.heading": "Subtasks",
	"tasks.subtasks.progress": "{done}/{total}",
	"tasks.subtasks.addPlaceholder": "Add a subtask…",

	// Dependencies / blocked-by (9.14.8)
	"tasks.dependencies.region": "Blocked by",
	"tasks.dependencies.heading": "Blocked by",
	"tasks.dependencies.blocked": "Blocked",
	"tasks.dependencies.remove": "Remove blocker",
	"tasks.dependencies.add": "+ Add blocker",
	"tasks.dependencies.pickerTitle": "Block on…",
	"tasks.dependencies.noCandidates": "No other tasks to block on",
	"tasks.header.inspector.show": "Show properties",
	"tasks.header.inspector.hide": "Hide properties",

	// Seeded `task-status` vocabulary labels (a user-renamed / custom state
	// falls back to its humanized key).
	"tasks.status.todo": "To-do",
	"tasks.status.in-progress": "In progress",
	"tasks.status.active": "In progress",
	"tasks.status.done": "Done",
	"tasks.status.cancelled": "Cancelled",

	// Inline-task embed (9.14.3 — the `/task` slash command + picker + card)
	"tasks.embed.command.label": "Task",
	"tasks.embed.command.description": "Embed a live task inline",
	"tasks.embed.menu.region": "Embed a task",
	"tasks.embed.menu.placeholder": "Search tasks…",
	"tasks.embed.menu.search": "Search tasks to embed",
	"tasks.embed.menu.results": "Tasks",
	"tasks.embed.menu.empty": "No tasks to embed",
	"tasks.embed.menu.noResults": "No tasks match “{query}”",
	"tasks.embed.untitled": "Untitled task",
	"tasks.embed.typeUnknown": "Entity",

	// Object menu (shared cross-app menu chrome)
	"tasks.menu.more": "More actions",
	"tasks.menu.moreDisabled": "Open a task or project to see its actions",
	"tasks.menu.open": "Open",
	"tasks.menu.pin": "Pin to dashboard",
	"tasks.menu.unpin": "Remove from dashboard",
	"tasks.menu.remove": "Delete",

	// Export… (IE-8 — generic entity export to a file)
	"tasks.export.action": "Export…",
	"tasks.export.title": "Export task",
	"tasks.export.projectTitle": "Export tasks",
	"tasks.export.formatLegend": "Format",
	"tasks.export.cancel": "Cancel",
	"tasks.export.markdown": "Markdown",
	"tasks.export.csv": "CSV",
	"tasks.export.json": "JSON",
} as const;

export type TranslationKey = keyof typeof DEFAULTS;
export type TranslationParams = Record<string, string | number>;

const translate = createT(DEFAULTS);
const KNOWN_KEYS = new Set(Object.keys(DEFAULTS));

export function t(key: string, params?: TranslationParams): string {
	if (!KNOWN_KEYS.has(key)) {
		if (typeof process !== "undefined" && process.env?.NODE_ENV !== "production") {
			console.warn(`[tasks/i18n] missing translation key: ${key}`);
		}
		return `[?${key}]`;
	}
	return translate(key as TranslationKey, params);
}

/** Tiny English-only plural switch (one / other). Delegates to
 *  `Intl.PluralRules` when the shell's locale layer lands (Stage 12). */
export function tCount(baseKey: string, count: number): string {
	const suffix = count === 0 ? "zero" : count === 1 ? "one" : "other";
	return t(`${baseKey}.${suffix}`, { count });
}
