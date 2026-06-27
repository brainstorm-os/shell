/**
 * Journal app i18n manifest + `t()`. Built on the shared SDK `createT`
 * (`@brainstorm/sdk/i18n`) so every user-visible string flows through one
 * typed lookup with `{name}` interpolation — no bare literals in `app.ts`.
 *
 * English defaults live here; a localised build passes a `Partial<…>`
 * override to `buildJournalT`. Pluralisation that depends on a count
 * (word / words) is two manifest keys selected at the call site, matching
 * the shell's `t.ts` convention (no embedded ICU plural in v1).
 */

import { createT, plural as sdkPlural } from "@brainstorm/sdk/i18n";
import type { TFunction, TParams } from "@brainstorm/sdk/i18n";

/** The frozen set of Journal string ids. The key set is fixed; values
 *  are `string` (not literal types) so a localised build can override
 *  any of them via `buildJournalT`. */
export type JournalI18nKey =
	| "previous"
	| "next"
	| "today"
	| "noEntryYet"
	| "writeHint"
	| "openInNotes"
	| "standaloneHint"
	| "wordOne"
	| "wordOther"
	| "linkedFrom"
	| "linksTo"
	| "insertLink"
	| "linkPickerTitle"
	| "linkPickerEmpty"
	| "link"
	| "mention"
	| "day"
	| "week"
	| "month"
	| "hasEntry"
	| "streakNone"
	| "streakOne"
	| "streakMany"
	| "streakAtRisk"
	| "reminder.label"
	| "reminder.timeLabel"
	| "reminder.notify.title"
	| "reminder.notify.body"
	| "reminder.notify.streak"
	| "goToDate"
	| "jumpToMonth"
	| "overviewHeading"
	| "overviewEmpty"
	| "export.button"
	| "export.title"
	| "export.monthMd"
	| "export.monthHtml"
	| "export.allMd"
	| "export.allHtml"
	| "export.saveDialogTitle"
	| "export.filterName"
	| "periodic.heading"
	| "periodic.thisWeek"
	| "periodic.lastWeek"
	| "periodic.thisMonth"
	| "periodic.lastMonth"
	| "templatesLabel"
	| "template.dailyReview"
	| "template.dailyReview.well"
	| "template.dailyReview.hard"
	| "template.dailyReview.tomorrow"
	| "template.gratitude"
	| "template.gratitude.heading"
	| "template.gratitude.prompt"
	| "template.freeWrite"
	| "template.freeWrite.prompt"
	| "checkIn.mood"
	| "checkIn.habits"
	| "mood.great"
	| "mood.good"
	| "mood.ok"
	| "mood.low"
	| "mood.bad"
	| "habit.exercise"
	| "habit.read"
	| "habit.meditate"
	| "habit.outside"
	| "habit.sleepWell"
	| "search.title"
	| "search.placeholder"
	| "search.hint"
	| "search.empty"
	| "search.filterMood"
	| "search.filterHabits"
	| "header.lock"
	| "header.unlock"
	| "moreActions"
	| "iconPicker"
	| "sidebar.show"
	| "sidebar.hide"
	| "properties.show"
	| "properties.hide"
	| "properties.title"
	| "properties.empty"
	| "properties.loading"
	| "properties.add"
	| "properties.remove"
	| "properties.meta.created"
	| "properties.meta.updated"
	| "properties.meta.words"
	| "properties.meta.dateKey"
	| "properties.openInNotesHint";

export type JournalManifest = Record<JournalI18nKey, string>;

export const JOURNAL_I18N: JournalManifest = Object.freeze({
	previous: "Previous",
	next: "Next",
	today: "Today",
	noEntryYet: "No entry yet.",
	writeHint: "Start writing your entry…",
	openInNotes: "Open in Notes",
	standaloneHint: "Running standalone — open Notes inside the shell to use this",
	wordOne: "{count} word",
	wordOther: "{count} words",
	linkedFrom: "Linked from ({count})",
	linksTo: "Links to ({count})",
	insertLink: "Link an entry",
	linkPickerTitle: "Link to entry",
	linkPickerEmpty: "No other entries to link",
	link: "link",
	mention: "mention",
	day: "Day",
	week: "Week",
	month: "Month",
	hasEntry: "Has entry",
	streakNone: "No active streak",
	streakOne: "1-day streak",
	streakMany: "{count}-day streak",
	streakAtRisk: "Write today to keep your {count}-day streak",
	"reminder.label": "Daily reminder",
	"reminder.timeLabel": "Reminder time",
	"reminder.notify.title": "Time to journal",
	"reminder.notify.body": "Take a moment to write today's entry.",
	"reminder.notify.streak": "Write today to keep your {count}-day streak.",
	goToDate: "Go to date",
	jumpToMonth: "Jump to month or year",
	overviewHeading: "All entries",
	overviewEmpty: "No entries yet.",
	"export.button": "Export",
	"export.title": "Export journal",
	"export.monthMd": "This month — Markdown",
	"export.monthHtml": "This month — HTML",
	"export.allMd": "All entries — Markdown",
	"export.allHtml": "All entries — HTML",
	"export.saveDialogTitle": "Export journal",
	"export.filterName": "Journal export",
	"periodic.heading": "Rollups",
	"periodic.thisWeek": "This week",
	"periodic.lastWeek": "Last week",
	"periodic.thisMonth": "This month",
	"periodic.lastMonth": "Last month",
	templatesLabel: "Start with a template",
	"template.dailyReview": "Daily review",
	"template.dailyReview.well": "What went well today?",
	"template.dailyReview.hard": "What was hard?",
	"template.dailyReview.tomorrow": "Tomorrow's focus",
	"template.gratitude": "Gratitude",
	"template.gratitude.heading": "Grateful for",
	"template.gratitude.prompt": "Three things I'm grateful for…",
	"template.freeWrite": "Free write",
	"template.freeWrite.prompt": "Whatever's on your mind — just write.",
	"checkIn.mood": "Mood",
	"checkIn.habits": "Habits",
	"mood.great": "Great",
	"mood.good": "Good",
	"mood.ok": "Okay",
	"mood.low": "Low",
	"mood.bad": "Rough",
	"habit.exercise": "Exercise",
	"habit.read": "Read",
	"habit.meditate": "Meditate",
	"habit.outside": "Outside",
	"habit.sleepWell": "Slept well",
	"search.title": "Search entries",
	"search.placeholder": "Search all entries…",
	"search.hint": "Type to search, or filter by mood and habits.",
	"search.empty": "No matching entries.",
	"search.filterMood": "Mood",
	"search.filterHabits": "Habits",
	"header.lock": "Lock entry (read-only)",
	"header.unlock": "Unlock entry",
	moreActions: "More actions",
	iconPicker: "Change icon",
	"sidebar.show": "Show calendar",
	"sidebar.hide": "Hide calendar",
	"properties.show": "Show properties",
	"properties.hide": "Hide properties",
	"properties.title": "Properties",
	"properties.empty": "No properties bound yet.",
	"properties.loading": "Loading properties…",
	"properties.add": "Add property",
	"properties.remove": "Remove {name}",
	"properties.meta.created": "Created",
	"properties.meta.updated": "Updated",
	"properties.meta.words": "Words",
	"properties.meta.dateKey": "Date",
	"properties.openInNotesHint": "Use Notes for advanced property editing.",
});

export type JournalT = TFunction<JournalManifest>;

export function buildJournalT(overrides?: Partial<JournalManifest>): JournalT {
	return createT(JOURNAL_I18N, overrides);
}

/** Catalog-bound plural — picks `<base>One` / `<base>Other` (or the explicit
 *  key pair) and lets the shared helper own the `count === 1` selection. See
 *  the SDK `plural` doc: the count branch lives here, never in component code. */
export function journalPlural(
	t: JournalT,
	count: number,
	oneKey: JournalI18nKey,
	otherKey: JournalI18nKey,
	params?: TParams,
): string {
	return sdkPlural<JournalManifest>(t, count, oneKey, otherKey, params);
}
