/**
 * Bookmarks app i18n manifest — every user-visible string the renderer
 * emits, keyed and English-defaulted, consumed through the shared
 * `@brainstorm/sdk/i18n` `createT`. A localised build passes a
 * `Partial<BookmarksMessages>` of overrides; missing keys degrade to
 * the English default (never a crash) per the shared `t()` contract.
 *
 * No bare string literal may reach the DOM — it goes through a key here.
 */

import { type TParams, createT, plural as sdkPlural } from "@brainstorm/sdk/i18n";

export const BOOKMARKS_MESSAGES = {
	"surface.inbox": "Inbox",
	"surface.read": "Read",
	"surface.archive": "Archive",
	// A board view grouped by tag — named distinctly from the "Tags" filter
	// list in the same sidebar so the two aren't the same word stacked (F-050).
	"surface.tags": "Tag board",

	"header.sidebar.show": "Show sidebar",
	"header.sidebar.hide": "Hide sidebar",
	"header.inspector.show": "Show properties",
	"header.inspector.hide": "Hide properties",

	"nav.surfaces": "Surfaces",
	"sidebar.tags": "Tags",
	"sidebar.resize": "Resize sidebar",
	// The accessible name of the (virtualized) bookmark card list, exposed as a
	// keyboard-navigable listbox (KBN-A-bookmarks).
	"a11y.cardList": "Bookmarks",
	"tag.all": "All",
	"tag.untagged": "Untagged",

	// Collections (9.18.10) — saved smart filters in the sidebar.
	"collections.title": "Collections",
	"collections.save": "Save current view as a collection",
	"collections.empty": "Save a filtered view to keep it here.",
	"collections.remove": "Remove collection",

	"main.tag.untagged": "Untagged",
	"main.tag.named": "#{tag}",
	"main.subtitle.one": "1 bookmark",
	"main.subtitle.many": "{count} bookmarks",

	"empty.inbox": "No bookmarks in the inbox.",
	"empty.read": "No read bookmarks yet.",
	"empty.read.hint": "Mark a bookmark as read and it appears here.",
	"empty.archive": "No archived bookmarks.",
	"empty.archive.hint": "Archive a bookmark from its ⋯ menu and it lands here.",
	"empty.tags.named": "No bookmarks tagged {tag}.",
	"empty.tags.none": "No bookmarks yet — add tags as you save links.",
	"empty.collection": "No bookmarks match this collection.",

	"action.markRead": "Mark read",
	"action.markUnread": "Mark unread",
	"action.archive": "Archive",
	"action.unarchive": "Unarchive",
	"action.changeIcon": "Change icon",
	"action.editTags": "Edit tags",
	"action.moreActions": "More actions",
	"action.addBookmark": "Add bookmark",
	"action.openLink": "Open {title} in a new tab",
	"action.openBookmark": "Open {title}",
	"action.back": "Back to list",

	"detail.openOriginal": "Open original",
	"detail.loading": "Loading the page's content…",
	"detail.noContent": "This page has no extractable article content.",
	"detail.notCaptured": "Content not captured yet.",
	"detail.capture": "Capture content",
	"detail.reload": "Reload from source",
	"detail.forget": "Forget captured content",
	// Capture-state feedback (9.18.12).
	"capture.capturing": "Capturing the page's content…",
	"capture.error": "Couldn't fetch this page's content — the bookmark is saved; try again anytime.",
	"capture.retry": "Try again",
	"detail.bodyPlaceholder":
		"No content captured — write your own notes, or capture the page from the ⋯ menu.",
	"detail.properties": "Properties",
	// Property-panel row labels (the bridged `Bookmark` fields rendered through
	// the shared property cells).
	"prop.url": "URL",
	"prop.site": "Site",
	"prop.type": "Type",
	"prop.author": "Author",
	"prop.published": "Published",
	"prop.description": "Description",
	"prop.tags": "Tags",
	"prop.saved": "Saved",
	"prop.read": "Read",
	"prop.archived": "Archived",
	// The user's own freeform notes about the link — distinct from the scraped
	// `Description`; an editable multi-line field on the bookmark.
	"prop.notes": "Notes",
	// The vault dictionary backing the panel's Tags cell ("Manage values"
	// shows this as the vocabulary's name).
	"detail.tagsDictionaryName": "Bookmark tags",
	"detail.cover.edit": "Change cover",
	"detail.lock": "Lock bookmark (read-only)",
	"detail.unlock": "Unlock bookmark",
	"detail.cover.add": "Add cover",
	// Capture provenance + large-page warning (9.18.13).
	"detail.provenance.machine": "Machine-extracted from the page · captured {date}",
	"detail.truncation":
		"This is a large page — the captured reading copy may be incomplete. Open the original for the full article.",

	"compose.title": "Add bookmark",
	"compose.url.label": "URL",
	"compose.url.placeholder": "https://example.com/article",
	"compose.title.label": "Title",
	"compose.title.placeholder": "Optional — defaults to the domain",
	"compose.description.label": "Description",
	"compose.description.placeholder": "Optional note about this link",
	"compose.tags.label": "Tags",
	"compose.tags.placeholder": "Comma-separated, e.g. read-later, design",
	"compose.downloadContent": "Download page content for offline reading",
	"compose.submit": "Save bookmark",
	"compose.cancel": "Cancel",
	"compose.error.invalidUrl": "Enter a valid http(s) URL.",
	"compose.error.duplicate": "That URL is already bookmarked.",

	"tags.title": "Edit tags",
	"tags.label": "Tags",
	"tags.placeholder": "Comma-separated tags",
	"tags.submit": "Save",
	"tags.cancel": "Cancel",

	"menu.remove": "Remove bookmark",

	// Flexible board "Group by ▾" header control + its menu (mirrors Tasks'
	// Upcoming grouping). The caption interpolates the active axis name.
	"header.groupBy": "Group by {axis}",
	"group.menuLabel": "Group bookmarks by",
	"group.tags": "Tag",
	"group.domain": "Domain",
	"group.site": "Site",
	"group.savedDate": "Date saved",
	"group.author": "Author",
	// SavedDate period lane headings — most recent first.
	"group.period.today": "Today",
	"group.period.week": "This week",
	"group.period.month": "This month",
	"group.period.older": "Older",
	// Trailing buckets for the non-tag axes when the value is missing.
	"group.unknown.domain": "Unknown domain",
	"group.unknown.site": "Unknown site",
	"group.unknown.author": "Unknown author",

	// Dashboard widget (Stage 7.3). Title / open chrome is drawn by the shell's
	// widget strip; the app supplies the body — the glance list, its empty state,
	// the in-widget sort control, and the live count.
	"widget.empty": "No bookmarks yet",
	"widget.emptyAction": "Open Bookmarks",
	"widget.sort.label": "Sort bookmarks",
	"widget.sort.recent": "Recently added",
	"widget.sort.title": "Title (A–Z)",
	"widget.untitled": "Untitled bookmark",
	"widget.count.one": "{count} bookmark",
	"widget.count.many": "{count} bookmarks",

	// Duplicate detection + merge (9.18.11). `count` is the number of redundant
	// copies that merging would remove. Two keys (one/many) mirror the
	// `main.subtitle.*` pattern this app already uses for simple plurals.
	"dedup.banner.one": "1 duplicate link found.",
	"dedup.banner.many": "{count} duplicate links found.",
	"dedup.merge": "Merge",

	// Content-kind labels (9.18.14) — the friendly fold of a raw OpenGraph
	// `og:type`. Surfaced as the "Type" property value + a card badge.
	"contentKind.article": "Article",
	"contentKind.video": "Video",
	"contentKind.audio": "Audio",
	"contentKind.image": "Image",
	"contentKind.book": "Book",
	"contentKind.profile": "Profile",
	"contentKind.product": "Product",
	"contentKind.website": "Website",
	"contentKind.page": "Page",
} as const;

export type BookmarksMessages = typeof BOOKMARKS_MESSAGES;
export type BookmarksMessageKey = keyof BookmarksMessages;

/** The app-wide `t`. Pass `overrides` only in a localised build. */
export const t = createT<Record<BookmarksMessageKey, string>>(BOOKMARKS_MESSAGES);

/** Catalog-bound plural — picks `<base>.one` / `<base>.many`. The count
 *  selection lives in the shared helper, not in component code. */
export const plural = (
	count: number,
	oneKey: BookmarksMessageKey,
	otherKey: BookmarksMessageKey,
	params?: TParams,
): string => sdkPlural(t, count, oneKey, otherKey, params);
