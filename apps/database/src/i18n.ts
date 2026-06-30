/**
 * App-side translations per
 * §Localization — the shared `@brainstorm/sdk/i18n` `createT` (`{name}`
 * interpolation only, no ICU). Database predates the convention, so the
 * legacy strings in `app.ts` are tech debt migrating as adjacent code is
 * touched; every NEW user-visible string lands here first.
 */

import { type TParams, createT, plural as sdkPlural } from "@brainstorm/sdk/i18n";

const DEFAULTS = {
	// Row menu (shared object-menu extras)
	"brainstorm.database.menu.rename": "Rename",
	"brainstorm.database.menu.delete": "Delete",
	"brainstorm.database.menu.saveAsTemplate": "Save as template",

	// Create-flow template picker (B11.10 templates foundation)
	"brainstorm.database.create.pickTemplate": "New from template",
	"brainstorm.database.create.blank": "Blank",
	"brainstorm.database.status.templateSaved": "Saved as template",

	// Cross-app drag grip (DND-4)
	"brainstorm.database.row.drag": "Drag to another app",

	// Add-to-collection keyboard twin (DND-6 — the object-menu isomorph of
	// dropping an object onto a collection)
	"brainstorm.database.menu.addToCollection": "Add to collection…",
	"brainstorm.database.menu.collectionsRegion": "Collections",
	"brainstorm.database.menu.noCollections": "No collections yet",

	// View tab strip (9.12.9)
	"brainstorm.database.view.new": "New view",
	// View body empty states (grid / gallery / list / board)
	"brainstorm.database.view.empty": "No entities match this view.",
	"brainstorm.database.board.empty": "Drop cards here",
	"brainstorm.database.view.menu.rename": "Rename",
	"brainstorm.database.view.menu.duplicate": "Duplicate",
	"brainstorm.database.view.menu.delete": "Delete",
	"brainstorm.database.view.menu.delete.lastHint": "A list needs at least one view",
	"brainstorm.database.view.duplicated": "Duplicated to “{name}”",
	"brainstorm.database.view.deleted": "Deleted “{name}”",

	// List context menu (9.12.9)
	"brainstorm.database.list.menu.rename": "Rename",
	"brainstorm.database.list.menu.duplicate": "Duplicate",
	"brainstorm.database.list.menu.delete": "Delete",
	"brainstorm.database.list.menu.delete.lastHint": "A database needs at least one list",
	"brainstorm.database.list.duplicated": "Duplicated to “{name}”",
	"brainstorm.database.list.deleted": "Deleted “{name}”",
	"brainstorm.database.list.created": "Created “{name}”",

	// Calendar / shared view chrome (9.12.6)
	"brainstorm.database.calendar.more": "+{count} more",
	"brainstorm.database.calendar.dayItems.one": "{count} item",
	"brainstorm.database.calendar.dayItems.other": "{count} items",

	// Delete-row confirm
	"brainstorm.database.delete.title": "Delete object?",
	"brainstorm.database.delete.body":
		"“{name}” will be deleted from the vault — it disappears from every list, search, and the graph.",
	"brainstorm.database.delete.confirm": "Delete",
	"brainstorm.database.delete.cancel": "Cancel",
	"brainstorm.database.delete.unavailable":
		"Delete needs the entities service (not exposed by this shell)",
	"brainstorm.database.delete.done": "Deleted “{name}”",
	"brainstorm.database.delete.failed": "Delete failed — {message}",

	// Timeline empty states (F-211)
	"brainstorm.database.timeline.emptyNoValues":
		"No items have a value for “{property}”. Pick a different date property under View settings → Dates.",
	"brainstorm.database.timeline.emptyNoDateProperty":
		"This collection has no date property to lay out. Add a date column, then bind it under View settings → Dates.",

	// Sidebar System section (F-212)
	"brainstorm.database.sidebar.system": "System",
	"brainstorm.database.sidebar.systemToggle": "Toggle the System section",

	// Read-only record lock (inspector header toggle)
	"brainstorm.database.record.lock": "Lock record (read-only)",
	"brainstorm.database.record.unlock": "Unlock record",
} as const;

export type DatabaseManifest = typeof DEFAULTS;
export type TranslationKey = keyof DatabaseManifest;

/** The app-side translate function (shared `createT`). A localised build
 *  calls `createT(DEFAULTS, overrides)`; v1 ships English only. */
export const t = createT(DEFAULTS);

/** Catalog-bound plural — picks `<base>.one` / `<base>.other`. The
 *  `count === 1` selection lives in the shared helper, never in component
 *  code (per §Localization). */
export const plural = (
	count: number,
	oneKey: TranslationKey,
	otherKey: TranslationKey,
	params?: TParams,
): string => sdkPlural(t, count, oneKey, otherKey, params);
