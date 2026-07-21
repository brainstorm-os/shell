/**
 * `ScheduledItem` — the unified row shape every Calendar view consumes.
 *
 * **Long-term keystone** per [[preview-drop-pattern]]: Events, Journal
 * entries, and *any* entity carrying a `Date`-typed property all project
 * into this shape. The renderer never branches on a fixed source enum — it
 * only reads `item.sourceKey` for the filter chip + colour default.
 *
 * Source identity is the dynamic `sourceKey` string, NOT a closed enum: the
 * calendar discovers which `(entity type · date property)` combinations exist
 * in the live vault (9.15f). Property-derived items key off
 * `${entityType}::${propertyKey}`; the two projections that aren't a plain
 * numeric date property (calendar-owned Events, journal title-dates) use the
 * fixed named keys below.
 */

import type { Icon, Recurrence } from "@brainstorm-os/sdk-types";

/** Calendar-owned `Event/v1` rows — their start/end live in the event, not a
 *  catalog Date property, so they get a fixed source key. */
export const EVENT_SOURCE_KEY = "calendar:event";
/** Journal entries plotted from their `YYYY-MM-DD` title (not a property). */
export const JOURNAL_SOURCE_KEY = "calendar:journal";

/** Compose a property-derived source key from an entity type + property key. */
export function sourceKeyFor(entityType: string, propertyKey: string): string {
	return `${entityType}::${propertyKey}`;
}

/** Split a property-derived source key back into its parts, or `null` for a
 *  built-in key (Event / Journal) that isn't `${type}::${prop}`. */
export function parseSourceKey(key: string): { entityType: string; propertyKey: string } | null {
	const idx = key.indexOf("::");
	if (idx < 0) return null;
	return { entityType: key.slice(0, idx), propertyKey: key.slice(idx + 2) };
}

/**
 * Per-source behaviour overrides — the single seam for the handful of sources
 * that need bespoke treatment, and the place future per-source config (colour,
 * recurrence, default visibility, custom label) plugs in. Keyed by source key.
 */
export type SourceOverride = {
	/** Legend / chip colour. Absent → a stable palette pick from the key. */
	color?: string;
	/** Project the value as a yearly-recurring anchor (birthdays). */
	yearlyRecurrence?: boolean;
	/** The calendar must not rewrite this date (dragging is disabled). */
	readonly?: boolean;
	/** Always project as an all-day item regardless of the stored time (a
	 *  birthday is inherently date-only even if the value carries a clock). */
	allDay?: boolean;
	/** Hidden by default until the user opts the source in. */
	defaultHidden?: boolean;
	/** i18n key (taking `{name}`) used to frame the chip title — e.g. a
	 *  birthday reads "Jane's birthday" rather than the bare person name. */
	titleTemplateKey?: string;
};

export const SOURCE_OVERRIDES: Readonly<Record<string, SourceOverride>> = Object.freeze({
	// Built-ins keep the colours the legend has always drawn (F-042).
	[EVENT_SOURCE_KEY]: { color: "#7c83ff" },
	[JOURNAL_SOURCE_KEY]: { color: "#9b7ede" },
	// A person's birthday recurs yearly and must never be rewritten from the
	// calendar (that would edit their birth date).
	[sourceKeyFor("brainstorm/Person/v1", "birthday")]: {
		color: "#c66a8c",
		yearlyRecurrence: true,
		readonly: true,
		allDay: true,
		titleTemplateKey: "calendar.item.birthday",
	},
	[sourceKeyFor("brainstorm/Task/v1", "scheduledAt")]: { color: "#d49241" },
	[sourceKeyFor("brainstorm/Task/v1", "dueAt")]: { color: "#c2703a" },
	// Completion dates would otherwise drop a surprise dot on every finished
	// task — available as a toggle, but off until asked for.
	[sourceKeyFor("brainstorm/Task/v1", "completedAt")]: { defaultHidden: true },
	[sourceKeyFor("brainstorm/Note/v1", "date")]: { color: "#5da27e" },
});

/** A curated palette for sources without an explicit override colour. Stable
 *  per key so a given `(type · property)` always wears the same colour. */
const SOURCE_PALETTE: readonly string[] = Object.freeze([
	"#5da27e",
	"#3b82f6",
	"#d49241",
	"#c66a8c",
	"#14b8a6",
	"#9b7ede",
	"#dc5b5b",
	"#7c83ff",
	"#6b7280",
	"#b8923a",
]);

function hashIndex(key: string, mod: number): number {
	let h = 2166136261;
	for (let i = 0; i < key.length; i++) {
		h ^= key.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return Math.abs(h) % mod;
}

/** The legend colour for a source key: its override colour, else a stable
 *  palette pick. The single source of truth shared by the sidebar legend AND
 *  the rendered chips/dots, so the key the legend draws is the colour items
 *  actually wear (F-042). */
export function colorForSourceKey(key: string): string {
	const override = SOURCE_OVERRIDES[key];
	if (override?.color) return override.color;
	const picked = SOURCE_PALETTE[hashIndex(key, SOURCE_PALETTE.length)];
	return picked ?? SOURCE_PALETTE[0] ?? "#7c83ff";
}

export type ScheduledItem = {
	/** Stable item id — distinct from `sourceEntityId` because a single
	 *  recurring event expands into multiple `ScheduledItem`s, and a single
	 *  entity can project once per date property it carries. */
	id: string;
	/** Dynamic source identity (`${type}::${prop}` or a built-in key). Drives
	 *  the filter toggle membership + the colour default. */
	sourceKey: string;
	/** Entity id in the source app (e.g. the `Task` row id for a
	 *  `Task/v1::scheduledAt` projection). `intent.dispatch("open", { entityId })`
	 *  uses this to round-trip back to the owning app. */
	sourceEntityId: string;
	title: string;
	/** The source object's own icon, projected through so every view
	 *  (chip / block / agenda row) can paint it next to the title — the
	 *  same per-object identity the rest of the shell shows. `null` when
	 *  the source has no icon set (renders as nothing, never a default
	 *  glyph, per [[feedback_no_default_type_icon_fallback]]). */
	icon: Icon | null;
	/** Epoch ms — start instant. Required. */
	start: number;
	/** Epoch ms — end instant. `null` for instant items (a task ping, a
	 *  birthday). */
	end: number | null;
	allDay: boolean;
	location: string | null;
	recurrence: Recurrence | null;
	colorHint: string | null;
	/** Vocabulary key into the `event-status` dictionary (`confirmed` /
	 *  `tentative` / `cancelled`). Only Calendar-owned Events carry one; a
	 *  projected Task / Birthday leaves it absent. Drives the chip's
	 *  `data-status` treatment (cancelled struck-through, tentative
	 *  translucent). */
	statusKey?: string | null;
	/** Number of attendees on the source Event — shown as a "N guests"
	 *  meta line on the longer chip variants. Absent / 0 renders nothing. */
	attendeeCount?: number;
	/** IANA zone the source event is authored in. When set and different
	 *  from the viewer's local zone, the chip badges the short zone name
	 *  (the grid still positions the item by its absolute instant). */
	timeZone?: string | null;
	/** Set by `expandRecurringItems` on a materialized occurrence. The
	 *  occurrence keeps its `recurrence` (so the chip can badge + name the
	 *  pattern), and this flag both marks it for the renderer and makes
	 *  expansion idempotent (a tagged item is never re-expanded). */
	isRecurringInstance?: boolean;
	/** Marks an item whose schedule the Calendar app cannot rewrite —
	 *  e.g. a Person birthday (changing the chip would rewrite the
	 *  person's birth date, which is not what the user intends). Read-only
	 *  items render normally but get no drag affordance. */
	readonly?: boolean;
	/** The source object is completed (a done Task). Completed items stay on
	 *  the date-grid views as history, but are excluded from the forward-looking
	 *  Agenda — a done follow-up shouldn't read as still-upcoming (F-028). */
	done?: boolean;
};

/** Pure predicate: does this item have a real duration (i.e. should the
 *  Week / Day view render it as a span rather than a single dot)?
 *  All-day items are NOT spans for this purpose — they get their own
 *  pinned-top region in Week / Day views. */
export function hasDuration(item: ScheduledItem): boolean {
	if (item.allDay) return false;
	if (item.end === null) return false;
	return item.end > item.start;
}

/** Final instant of an item — `end ?? start`. */
export function finalInstant(item: ScheduledItem): number {
	return item.end ?? item.start;
}

/** The colour an item wears: its own `colorHint` wins, else its source's
 *  legend colour. Centralises the `colorHint ?? source colour` rule the chip,
 *  month ribbon, and sidebar all share. */
export function colorForItem(item: ScheduledItem): string {
	return item.colorHint ?? colorForSourceKey(item.sourceKey);
}
