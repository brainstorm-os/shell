/**
 * Bookmark properties bridge (interim, kv-era). A bookmark's editable
 * attributes — URL, site, saved date, read/archived status — are vault
 * PROPERTIES, surfaced through the shared property-value cells
 * (`@brainstorm-os/sdk/property-ui`) rather than hand-rolled rows
 * ([[feedback-no-hand-rolled-property-panels]]).
 *
 * Bookmarks still store these as first-class `Bookmark` fields in the kv
 * silo, so this module BRIDGES: it synthesises a `PropertyDef` + a
 * `ValuesMap` from the typed fields for rendering, and maps an edited cell
 * value back to a `Partial<Bookmark>`. When the OQ-DM-1 property-backed
 * migration lands (the bookmark becomes a property-bearing entity with a
 * real `values` map) the synthesis drops out and the same cells render the
 * entity's own values — zero UI change. The defs are transient (not
 * registered in the vault catalog) so the global Properties list isn't
 * polluted with field-bridge entries.
 */

import {
	CARDINALITY_HARD_MAX,
	DateGranularity,
	type Dictionary,
	type DictionaryItem,
	type LabeledValue,
	type PropertyDef,
	PropertyFormat,
	PropertyView,
	ValueType,
} from "@brainstorm-os/sdk-types";
import type { ValuesMap } from "@brainstorm-os/sdk/property-ui";
import { t } from "../i18n/manifest";
import type { BookmarksMessageKey } from "../i18n/manifest";
import { CONTENT_KIND_LABEL_KEY, ContentKind, classifyMediaType } from "../logic/content-kind";
import { domainFromUrl } from "../logic/url-parse";
import type { Bookmark } from "../types/bookmark";

/** The "Type" property value: the friendly content-kind label, or blank when no
 *  `og:type` was scraped (the generic `Page` default reads as no value rather
 *  than the literal "Page"). */
export function bookmarkTypeLabel(b: Bookmark): string {
	const kind = classifyMediaType(b.mediaType);
	if (kind === ContentKind.Page) return "";
	return t(CONTENT_KIND_LABEL_KEY[kind] as BookmarksMessageKey);
}

export const BOOKMARK_PROP_KEY = {
	url: "io.brainstorm.bookmarks/url",
	site: "io.brainstorm.bookmarks/site",
	type: "io.brainstorm.bookmarks/type",
	author: "io.brainstorm.bookmarks/author",
	published: "io.brainstorm.bookmarks/published",
	description: "io.brainstorm.bookmarks/description",
	notes: "io.brainstorm.bookmarks/notes",
	tags: "io.brainstorm.bookmarks/tags",
	saved: "io.brainstorm.bookmarks/saved",
	read: "io.brainstorm.bookmarks/read",
	archived: "io.brainstorm.bookmarks/archived",
} as const;

/** The vault dictionary backing the Tags cell. One fixed id so every
 *  bookmark's panel (and the future OQ-DM-1 property migration) shares
 *  the same vocabulary. */
export const BOOKMARK_TAGS_DICTIONARY_ID = "io.brainstorm.bookmarks/tags-dictionary";

/** Render order. URL / type / saved are read-only (identity / derived /
 *  scraped / timestamp); site is editable text (the publication name, backfilled
 *  from `og:site_name`, falling back to the domain — overridable, clear to
 *  resume the domain); description is editable text (backfilled from
 *  `og:description`, overridable); read + archived are editable booleans that
 *  toggle the bookmark's `readAt` / `archivedAt`. */
export const BOOKMARK_PROPERTY_DEFS: readonly PropertyDef[] = [
	{
		key: BOOKMARK_PROP_KEY.url,
		name: t("prop.url"),
		icon: null,
		valueType: ValueType.Text,
		format: PropertyFormat.Url,
	},
	{ key: BOOKMARK_PROP_KEY.site, name: t("prop.site"), icon: null, valueType: ValueType.Text },
	{ key: BOOKMARK_PROP_KEY.type, name: t("prop.type"), icon: null, valueType: ValueType.Text },
	// Scraped OG metadata (9.18.6), user-editable since F-204 — citation basics
	// the scraper often misses. Author is plain text; Published is a date.
	// Clearing either drops the field (the scrape may backfill it later).
	{ key: BOOKMARK_PROP_KEY.author, name: t("prop.author"), icon: null, valueType: ValueType.Text },
	{
		key: BOOKMARK_PROP_KEY.published,
		name: t("prop.published"),
		icon: null,
		valueType: ValueType.Date,
		granularity: DateGranularity.Date,
	},
	{
		key: BOOKMARK_PROP_KEY.description,
		name: t("prop.description"),
		icon: null,
		valueType: ValueType.Text,
		// Prose — render as a wrapping, multi-line field rather than a
		// single-line pill so a full description reads + edits comfortably.
		display: { view: PropertyView.Multiline },
	},
	{
		// The user's own freeform notes — distinct from the scraped Description.
		// Editable multi-line text, same cell as Description.
		key: BOOKMARK_PROP_KEY.notes,
		name: t("prop.notes"),
		icon: null,
		valueType: ValueType.Text,
		display: { view: PropertyView.Multiline },
	},
	{
		key: BOOKMARK_PROP_KEY.tags,
		name: t("prop.tags"),
		icon: null,
		valueType: ValueType.Text,
		vocabulary: { dictionaryId: BOOKMARK_TAGS_DICTIONARY_ID },
		count: { min: 0, max: CARDINALITY_HARD_MAX },
	},
	{
		key: BOOKMARK_PROP_KEY.saved,
		name: t("prop.saved"),
		icon: null,
		valueType: ValueType.Date,
		granularity: DateGranularity.Date,
	},
	// Boolean flags render as checkboxes — the one consistent boolean
	// affordance across every app (the Boolean default view). No switch override.
	{
		key: BOOKMARK_PROP_KEY.read,
		name: t("prop.read"),
		icon: null,
		valueType: ValueType.Boolean,
	},
	{
		key: BOOKMARK_PROP_KEY.archived,
		name: t("prop.archived"),
		icon: null,
		valueType: ValueType.Boolean,
	},
];

export const READONLY_BOOKMARK_PROP_KEYS: ReadonlySet<string> = new Set([
	BOOKMARK_PROP_KEY.url,
	BOOKMARK_PROP_KEY.type,
	BOOKMARK_PROP_KEY.saved,
]);

/** The ONE label↔id mapping for the tags vocabulary — every bridge
 *  direction (render, write-back, ensure) resolves through these two maps
 *  so the predicates can never drift apart. */
export function tagsLookup(dict: Dictionary | undefined): {
	byId: ReadonlyMap<string, DictionaryItem>;
	byLabel: ReadonlyMap<string, DictionaryItem>;
} {
	const byId = new Map<string, DictionaryItem>();
	const byLabel = new Map<string, DictionaryItem>();
	for (const item of dict?.items ?? []) {
		byId.set(item.id, item);
		if (!byLabel.has(item.label)) byLabel.set(item.label, item);
	}
	return { byId, byLabel };
}

/** A bookmark's label-string tags as the TagList cell's value shape:
 *  dictionary item IDS. A tag matching an item (by label, or by id for
 *  the ensure-seeded items where id == label) maps to that item's id; an
 *  unknown tag passes through verbatim so a chip still renders while the
 *  vocabulary catches up. */
export function tagsToCellValue(
	tags: readonly string[],
	dict: Dictionary | undefined,
): LabeledValue<string>[] {
	const { byId, byLabel } = tagsLookup(dict);
	return tags.map((tag) => {
		const item = byLabel.get(tag) ?? byId.get(tag);
		return { value: item?.id ?? tag };
	});
}

/** The TagList cell's edited value (item ids) back to the bookmark's
 *  label-string tags — the shape the tag board / sidebar tag list key on.
 *  Unknown ids (no dictionary yet) pass through; blanks drop; dedupes. */
export function tagsFromCellValue(next: unknown, dict: Dictionary | undefined): string[] {
	if (!Array.isArray(next)) return [];
	const { byId } = tagsLookup(dict);
	const out: string[] = [];
	for (const entry of next) {
		const id =
			typeof entry === "string"
				? entry
				: entry && typeof entry === "object" && typeof (entry as { value?: unknown }).value === "string"
					? (entry as { value: string }).value
					: null;
		if (id === null) continue;
		const item = byId.get(id);
		const label = (item?.label.trim() || id).trim();
		if (label.length > 0 && !out.includes(label)) out.push(label);
	}
	return out;
}

/** Synthesise the cell values for a bookmark, keyed by property def.
 *  `tagsDict` (when loaded) maps the label-string tags to dictionary item
 *  ids so the TagList chips pick up the items' colours. */
export function bookmarkToValues(b: Bookmark, tagsDict?: Dictionary): ValuesMap {
	return {
		[BOOKMARK_PROP_KEY.url]: b.url,
		[BOOKMARK_PROP_KEY.site]: b.siteName ?? domainFromUrl(b.url) ?? b.url,
		[BOOKMARK_PROP_KEY.type]: bookmarkTypeLabel(b),
		[BOOKMARK_PROP_KEY.author]: b.author ?? "",
		[BOOKMARK_PROP_KEY.published]:
			b.publishedAt !== undefined ? { at: b.publishedAt, granularity: DateGranularity.Date } : null,
		[BOOKMARK_PROP_KEY.description]: b.description ?? "",
		[BOOKMARK_PROP_KEY.notes]: b.notes ?? "",
		[BOOKMARK_PROP_KEY.tags]: tagsToCellValue(b.tags, tagsDict),
		[BOOKMARK_PROP_KEY.saved]: { at: b.savedAt, granularity: DateGranularity.Date },
		[BOOKMARK_PROP_KEY.read]: b.readAt !== null,
		[BOOKMARK_PROP_KEY.archived]: b.archivedAt !== null,
	};
}

/** Map an edited cell value back to bookmark fields, or null for the
 *  read-only props (the panel renders those non-editable anyway). `now` is
 *  injected so the timestamp is testable. */
export function applyBookmarkPropertyValue(
	key: string,
	next: unknown,
	now: number,
	tagsDict?: Dictionary,
): Partial<Bookmark> | null {
	switch (key) {
		case BOOKMARK_PROP_KEY.site: {
			// Clearing the publication name drops `siteName` so the domain
			// fallback (`bookmarkToValues`) resumes; a non-empty value overrides it.
			const text = typeof next === "string" ? next.trim() : "";
			return { siteName: text.length > 0 ? text : undefined };
		}
		case BOOKMARK_PROP_KEY.description: {
			const text = typeof next === "string" ? next.trim() : "";
			return { description: text };
		}
		case BOOKMARK_PROP_KEY.notes: {
			const text = typeof next === "string" ? next.trim() : "";
			return { notes: text };
		}
		case BOOKMARK_PROP_KEY.author: {
			// Clearing drops the field entirely (a later scrape may backfill it).
			const text = typeof next === "string" ? next.trim() : "";
			return { author: text.length > 0 ? text : undefined };
		}
		case BOOKMARK_PROP_KEY.published: {
			// The date cell commits a DateValue ({ at, granularity }) or null on clear.
			const at = next !== null && typeof next === "object" ? (next as { at?: unknown }).at : null;
			return { publishedAt: typeof at === "number" && Number.isFinite(at) ? at : undefined };
		}
		case BOOKMARK_PROP_KEY.tags:
			return { tags: tagsFromCellValue(next, tagsDict) };
		case BOOKMARK_PROP_KEY.read:
			return { readAt: next ? now : null };
		case BOOKMARK_PROP_KEY.archived:
			return { archivedAt: next ? now : null };
		default:
			return null;
	}
}

/** The slice of `PropertiesService` the dictionary ensure needs. */
export type TagsDictionaryIO = {
	getDictionary(id: string): Promise<Dictionary | null>;
	setDictionary(dict: Dictionary): Promise<void>;
};

/**
 * Create the bookmark-tags dictionary if absent and backfill an item for
 * every in-use tag it doesn't know (seeded items use `id == label`, so
 * legacy string tags round-trip identically; cell-created items keep
 * their minted ids and resolve by label). No-op when nothing is missing,
 * so calling on every boot is cheap and idempotent.
 */
export async function ensureBookmarkTagsDictionary(
	io: TagsDictionaryIO,
	name: string,
	tagsInUse: readonly string[],
): Promise<void> {
	const existing = await io.getDictionary(BOOKMARK_TAGS_DICTIONARY_ID);
	const base: Dictionary = existing ?? { id: BOOKMARK_TAGS_DICTIONARY_ID, name, items: [] };
	const lookup = tagsLookup(base);
	const known = new Set([...lookup.byId.keys(), ...lookup.byLabel.keys()]);
	const missing = [...new Set(tagsInUse.map((tag) => tag.trim()).filter((tag) => tag.length > 0))]
		.filter((tag) => !known.has(tag))
		.sort();
	if (existing !== null && missing.length === 0) return;
	let sortIndex = base.items.reduce((max, it) => Math.max(max, it.sortIndex + 1), 0);
	const added: DictionaryItem[] = missing.map((label) => ({
		id: label,
		label,
		icon: null,
		sortIndex: sortIndex++,
	}));
	await io.setDictionary({ ...base, items: [...base.items, ...added] });
}
