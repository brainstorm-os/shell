/**
 * Bookmarks app — the React root (9.18.x feature set, faithfully converted
 * from the prior imperative `app.ts`). The whole surface — header chrome,
 * collections + tag sidebar, surfaces nav, flat card list, tag Kanban board,
 * capture, dedup, compose, and the detail panel — is React; only the per-object
 * cover / icon / favicon (DOM-only SDK factories) and the captured-page editor
 * stay behind ref boundaries.
 *
 * Data source resolution:
 *   - **shell launch** (`window.brainstorm` present): hydrate from the
 *     `BookmarksRepository` (shared entities service); the live list flows
 *     through `useLiveEntities` (the ONE shared reactivity stack — it owns the
 *     `vaultEntities.onChange` wiring + trailing coalesce + first-load), keyed
 *     off the coarse vault signal with `bookmarkListEquals` short-circuiting.
 *   - **standalone** (`window.brainstorm` undefined): fall back to
 *     `buildBookmarksDemo()`; mutations stay in memory.
 *
 * Layout:
 *   - left sidebar: 4 surfaces + the (virtualized) tag list + saved collections;
 *     "Add bookmark" lives in the header as a + button.
 *   - main pane: bookmark cards (virtualized) or the per-tag Kanban board. Every
 *     per-card action lives in the ⋯ object menu (right-click also opens it).
 */

import "@brainstorm/sdk/app-theme.css";
import "@brainstorm/editor/editor.css";
import "@brainstorm/editor/editor-theme.css";
import "@brainstorm/sdk/count-badge.css";
import "./types";
import { type LiveEntitiesSource, YDocProvider, useLiveEntities } from "@brainstorm/react-yjs";
import { Orientation, SelectionAttribute, useCompositeKeyboard } from "@brainstorm/sdk/a11y";
import { CountBadge } from "@brainstorm/sdk/count-badge";
import { EmptyState } from "@brainstorm/sdk/empty-state";
import { Icon, IconName } from "@brainstorm/sdk/icon";
import { NavButtons, createNavHistory } from "@brainstorm/sdk/nav-history";
import type {
	ObjectMenuChromeLabels,
	ObjectMenuExtraItem,
	ObjectMenuRuntime,
	OpenObjectMenuOptions,
} from "@brainstorm/sdk/object-menu";
import {
	ObjectMenuMoreButton,
	openAnchoredMenu,
	openObjectMenu,
} from "@brainstorm/sdk/object-menu";
import { PanelSide, PanelToggleButton } from "@brainstorm/sdk/panel-toggle";
import { openCoverPicker, openIconPicker } from "@brainstorm/sdk/picker-host";
import { attachResizable } from "@brainstorm/sdk/resizable";
import { useShortcut } from "@brainstorm/sdk/shortcut";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
	type DragEvent as ReactDragEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { buildBookmarksDemo } from "./demo/dataset";
import { plural, t } from "./i18n/manifest";
import {
	type BoardLane,
	type BoardLaneLabels,
	SavedPeriod,
	buildBoardLanes,
} from "./logic/board-lanes";
import { bookmarkListEquals } from "./logic/bookmark-list-equals";
import { capturedBlocksToApply } from "./logic/capture-merge";
import { captureActionsFor, deriveCaptureState } from "./logic/capture-state";
import {
	type Collection,
	collectionCount,
	collectionMembers,
	smartCollectionFromView,
} from "./logic/collections";
import { type DuplicateGroup, findDuplicateGroups, mergeBookmarks } from "./logic/dedup";
import { metadataBackfill, preferScrapedAuthor, preferScrapedPublishedAt } from "./logic/enrich";
import { runSaveEnrichment } from "./logic/save-enrichment";
import { filterForSurface, surfaceFor } from "./logic/surface-for";
import { reorderTags, retagForLaneMove, uniqueTags } from "./logic/tag-utils";
import { domainFromUrl } from "./logic/url-parse";
import { ensureBookmarkTagsDictionary } from "./properties/bookmark-properties";
import { COLLECTIONS_KEY, parseCollections } from "./storage/collections-codec";
import { createEntitiesRepository } from "./storage/entities-repository";
import type { BookmarksRepository } from "./storage/repository";
import { getBrainstorm } from "./storage/runtime";
import {
	type BookmarkSettings,
	DEFAULT_BOOKMARK_SETTINGS,
	SETTINGS_KEY,
	parseBookmarkSettings,
} from "./storage/settings-codec";
import { getBookmarkResolver } from "./storage/ydoc-resolver";
import type { Bookmark } from "./types/bookmark";
import { BOOKMARK_ENTITY_TYPE, ContentProvenance } from "./types/bookmark";
import {
	BOOKMARK_GROUPINGS,
	BOOKMARK_SURFACES,
	BookmarkGrouping,
	BookmarkSurface,
} from "./types/surface";
import { BookmarkCard } from "./ui/bookmark-card";
import { BookmarkDetail } from "./ui/bookmark-detail";
import { openComposeBookmark, openEditTags } from "./ui/compose-bookmark";
import { ENTITY_ID_ATTR } from "./ui/delegated-object-menu";

const UNTAGGED = "__untagged__";
const TAG_ORDER_KEY = "tag-board-order";
const CARD_DND_TYPE = "application/x-brainstorm-bookmark-card";
const LANE_DND_TYPE = "application/x-brainstorm-bookmark-lane";

const NAV_OPEN_KEY = "bookmarks:nav-open";
const PROPS_OPEN_KEY = "bookmarks:props-open";
const BOARD_GROUPING_KEY = "bookmarks:board-grouping";

const TAG_ROW_HEIGHT = 28;
const CARD_ROW_ESTIMATE = 104;

const SURFACE_MESSAGE_KEY: Readonly<Record<BookmarkSurface, Parameters<typeof t>[0]>> = {
	[BookmarkSurface.Inbox]: "surface.inbox",
	[BookmarkSurface.Read]: "surface.read",
	[BookmarkSurface.Archive]: "surface.archive",
	[BookmarkSurface.Tags]: "surface.tags",
};

/** Each surface's shared-registry glyph (B-2): Inbox=tray, Read=check-circle,
 *  Archive=archive box, Tags=tag. */
const SURFACE_ICON: Readonly<Record<BookmarkSurface, IconName>> = {
	[BookmarkSurface.Inbox]: IconName.Inbox,
	[BookmarkSurface.Read]: IconName.Read,
	[BookmarkSurface.Archive]: IconName.Archive,
	[BookmarkSurface.Tags]: IconName.Tag,
};

/** A row in the sidebar tag list: the "All" pseudo-row, a named tag, or the
 *  "Untagged" bucket. */
enum TagRowKind {
	All = "all",
	Tag = "tag",
	Untagged = "untagged",
}
type TagRow = { kind: TagRowKind; tag: string | null; count: number };

type BookmarksNavLoc = {
	surface: BookmarkSurface;
	tag: string | null;
	openId: string | null;
	collectionId: string | null;
};

function readPref(key: string, fallback: boolean): boolean {
	try {
		const raw = localStorage.getItem(key);
		if (raw === null) return fallback;
		return raw === "true";
	} catch {
		return fallback;
	}
}

function writePref(key: string, value: boolean): void {
	try {
		localStorage.setItem(key, String(value));
	} catch {
		// private mode / quota — pref reverts to default on reload.
	}
}

/** The persisted board grouping axis, validated against the enum set so a
 *  stale / corrupt value degrades to the Tags default (the original
 *  behaviour). Mirrors Tasks' `readGroupingPref`. */
function readGroupingPref(): BookmarkGrouping {
	try {
		const raw = localStorage.getItem(BOARD_GROUPING_KEY);
		if (raw !== null && (BOOKMARK_GROUPINGS as readonly string[]).includes(raw)) {
			return raw as BookmarkGrouping;
		}
	} catch {
		// fall through to the default
	}
	return BookmarkGrouping.Tags;
}

function writeGroupingPref(value: BookmarkGrouping): void {
	try {
		localStorage.setItem(BOARD_GROUPING_KEY, value);
	} catch {
		// private mode / quota — pref reverts to default on reload.
	}
}

/** i18n key for each grouping axis's display label. */
const GROUP_LABEL_KEY: Readonly<Record<BookmarkGrouping, Parameters<typeof t>[0]>> = {
	[BookmarkGrouping.Tags]: "group.tags",
	[BookmarkGrouping.Domain]: "group.domain",
	[BookmarkGrouping.Site]: "group.site",
	[BookmarkGrouping.SavedDate]: "group.savedDate",
	[BookmarkGrouping.Author]: "group.author",
};

/** Localized label callbacks for the pure `buildBoardLanes` — stable
 *  module-level identity so it isn't rebuilt per render. */
const BOARD_LANE_LABELS: BoardLaneLabels = {
	savedPeriod: (period) => {
		switch (period) {
			case SavedPeriod.Today:
				return t("group.period.today");
			case SavedPeriod.Week:
				return t("group.period.week");
			case SavedPeriod.Month:
				return t("group.period.month");
			case SavedPeriod.Older:
				return t("group.period.older");
		}
	},
	unknownDomain: () => t("group.unknown.domain"),
	unknownSite: () => t("group.unknown.site"),
	unknownAuthor: () => t("group.unknown.author"),
};

function newCollectionId(): string {
	const c = globalThis.crypto;
	if (c && typeof c.randomUUID === "function") return `col-${c.randomUUID()}`;
	return `col-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function newBookmarkId(): string {
	const c = globalThis.crypto;
	if (c && typeof c.randomUUID === "function") return c.randomUUID();
	return `bm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** A stable empty list so the `useLiveEntities` `initial` identity is steady. */
const EMPTY_BOOKMARKS: Bookmark[] = [];

/** Keep a virtualized-list cursor inside the data bounds after the row set
 *  changes (a filter / mutation can shrink the list under the cursor). An empty
 *  list parks at 0 so the next non-empty render lands on the first row. */
function clampCursor(cursor: number, count: number): number {
	if (count <= 0) return 0;
	return Math.min(Math.max(cursor, 0), count - 1);
}

type CardDragPayload = { id: string; fromTag: string | null };

function parseCardPayload(raw: string): CardDragPayload | null {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return null;
		const { id, fromTag } = parsed as Record<string, unknown>;
		if (typeof id !== "string") return null;
		if (fromTag !== null && typeof fromTag !== "string") return null;
		return { id, fromTag };
	} catch {
		return null;
	}
}

export function BookmarksApp() {
	const runtime = useMemo(() => getBrainstorm(), []);
	const repository = useMemo<BookmarksRepository | null>(() => {
		const entitiesSvc = runtime?.services?.entities ?? null;
		if (!runtime || !entitiesSvc || !runtime.on) return null;
		return createEntitiesRepository(entitiesSvc);
	}, [runtime]);

	// Standalone (no shell): the in-memory demo dataset, mutated locally. Under
	// the shell the live list flows through `useLiveEntities` below and this
	// stays empty.
	const [demoBookmarks, setDemoBookmarks] = useState<Bookmark[]>(() =>
		repository ? EMPTY_BOOKMARKS : buildBookmarksDemo(),
	);

	// Live bookmark list through the ONE shared reactivity stack
	// (`@brainstorm/react-yjs`'s `useLiveEntities`). The hook owns the coarse
	// vault-change subscription (cross-app edits + dev reseed fire it), the
	// trailing-coalesce, and the first-subscribe load — replacing the per-app
	// `signal → listAll → setState` loop. We only hand it a `LiveEntitiesSource`:
	// the repo `listAll` as the loader plus the vault aggregator's change
	// subscription. `equals` is load-bearing: `listAll()` returns fresh objects,
	// so without it EVERY coarse vault change (any app's write) would re-render.
	const liveSource = useMemo<LiveEntitiesSource<Bookmark[]> | null>(() => {
		if (!repository) return null;
		const list = () => repository.listAll();
		const changes = runtime?.services?.vaultEntities;
		if (!changes) return { list };
		// Hand the coarse vault signal's subscribe to `useLiveEntities` (the shared
		// stack owns the loop). Invoke via `.call(changes)` so a `this`-bound impl
		// still gets its receiver — the live list must keep updating on cross-app
		// edits / dev reseed.
		const { onChange } = changes;
		return { list, onChange: (listener) => onChange.call(changes, listener) };
	}, [repository, runtime]);
	const liveBookmarks = useLiveEntities<Bookmark[]>(liveSource, {
		initial: EMPTY_BOOKMARKS,
		equals: bookmarkListEquals,
	});

	const bookmarks = repository ? liveBookmarks : demoBookmarks;

	// ── View state ──────────────────────────────────────────────────────
	const [surface, setSurface] = useState<BookmarkSurface>(BookmarkSurface.Inbox);
	const [selectedTag, setSelectedTag] = useState<string | null>(null);
	const [openBookmarkId, setOpenBookmarkId] = useState<string | null>(null);
	const [activeCollectionId, setActiveCollectionId] = useState<string | null>(null);
	const [collections, setCollections] = useState<Collection[]>([]);
	const [tagOrder, setTagOrder] = useState<string[]>([]);
	const [grouping, setGrouping] = useState<BookmarkGrouping>(readGroupingPref);
	const [settings, setSettings] = useState<BookmarkSettings>(() => ({
		...DEFAULT_BOOKMARK_SETTINGS,
	}));

	const [navOpen, setNavOpen] = useState(() => readPref(NAV_OPEN_KEY, true));
	const [propsOpen, setPropsOpen] = useState(() => readPref(PROPS_OPEN_KEY, false));

	// Capture lifecycle bookkeeping (9.18.12). `contentInFlight` / `captureErrors`
	// are sets stamped into state via a nonce bump so the detail + menus re-derive
	// the capture state. Kept in refs so the async capture closures read the live
	// set without re-binding.
	const contentInFlight = useRef<Set<string>>(new Set());
	const captureErrors = useRef<Set<string>>(new Set());
	const [, setCaptureNonce] = useState(0);
	const bumpCapture = useCallback(() => setCaptureNonce((n) => n + 1), []);

	// ── Nav history ─────────────────────────────────────────────────────
	const navRef = useRef<ReturnType<typeof createNavHistory<BookmarksNavLoc>> | null>(null);
	if (!navRef.current) {
		navRef.current = createNavHistory<BookmarksNavLoc>({
			initial: { surface, tag: selectedTag, openId: null, collectionId: null },
			persist: { key: "bookmarks:nav" },
		});
	}
	const nav = navRef.current;
	const recordNav = useCallback(
		(loc: {
			surface: BookmarkSurface;
			tag: string | null;
			openId: string | null;
			collectionId: string | null;
		}) => {
			nav.push(loc);
		},
		[nav],
	);
	const applyNavLoc = useCallback((loc: BookmarksNavLoc) => {
		setSurface(loc.surface);
		setSelectedTag(loc.tag);
		setOpenBookmarkId(loc.openId ?? null);
		setActiveCollectionId(loc.collectionId ?? null);
	}, []);

	// ── Mutations ───────────────────────────────────────────────────────
	// Under the shell, a mutation updates the entity through the repo and the
	// live list re-pulls via `useLiveEntities`; standalone, it patches the
	// in-memory demo set. Both paths share one `mutateBookmark`.
	const bookmarksRef = useRef(bookmarks);
	bookmarksRef.current = bookmarks;

	const mutateBookmark = useCallback(
		(id: string, fn: (b: Bookmark) => Bookmark): void => {
			const current = bookmarksRef.current.find((b) => b.id === id);
			if (!current) return;
			const next = fn(current);
			if (next === current) return;
			if (repository) {
				void repository.save(next);
			} else {
				setDemoBookmarks((list) => list.map((b) => (b.id === id ? next : b)));
			}
		},
		[repository],
	);

	const toggleRead = useCallback(
		(id: string, read: boolean) => {
			mutateBookmark(id, (b) => ({ ...b, readAt: read ? Date.now() : null, updatedAt: Date.now() }));
		},
		[mutateBookmark],
	);
	const toggleArchive = useCallback(
		(id: string, archive: boolean) => {
			mutateBookmark(id, (b) => ({
				...b,
				archivedAt: archive ? Date.now() : null,
				updatedAt: Date.now(),
			}));
		},
		[mutateBookmark],
	);

	const removeBookmark = useCallback(
		(id: string) => {
			if (!bookmarksRef.current.some((b) => b.id === id)) return;
			setOpenBookmarkId((open) => (open === id ? null : open));
			if (repository) void repository.remove(id);
			else setDemoBookmarks((list) => list.filter((b) => b.id !== id));
		},
		[repository],
	);

	// ── Content capture (Net-2) ─────────────────────────────────────────
	const captureContent = useCallback(
		async (bookmark: Bookmark): Promise<void> => {
			const network = getBrainstorm()?.services?.network;
			if (!network?.readable) return;
			if (contentInFlight.current.has(bookmark.id)) return;
			contentInFlight.current.add(bookmark.id);
			captureErrors.current.delete(bookmark.id);
			bumpCapture();
			try {
				const result = await network.readable({ url: bookmark.url });
				const blocks = capturedBlocksToApply(result.blocks);
				if (!blocks) {
					if (!bookmark.contentFetchedAt) {
						const now = Date.now();
						mutateBookmark(bookmark.id, (b) => {
							const backfill = metadataBackfill(b, result.preview);
							return { ...b, ...backfill, contentFetchedAt: now, updatedAt: now };
						});
					}
					return;
				}
				const now = Date.now();
				const scrapedDescription = result.preview.description.trim();
				mutateBookmark(bookmark.id, (b) => {
					const scrapedAuthor = preferScrapedAuthor(b.author, result.preview.author);
					const scrapedPublishedAt = preferScrapedPublishedAt(b.publishedAt, result.preview.publishedAt);
					return {
						...b,
						contentBlocks: blocks,
						contentFetchedAt: now,
						contentProvenance: ContentProvenance.MachineExtracted,
						updatedAt: now,
						...(!b.description?.trim() && scrapedDescription ? { description: scrapedDescription } : {}),
						...(scrapedAuthor !== null ? { author: scrapedAuthor } : {}),
						...(scrapedPublishedAt !== null ? { publishedAt: scrapedPublishedAt } : {}),
					};
				});
			} catch (error) {
				captureErrors.current.add(bookmark.id);
				console.warn(`[bookmarks] capture content failed for ${bookmark.url}:`, error);
			} finally {
				contentInFlight.current.delete(bookmark.id);
				bumpCapture();
			}
		},
		[mutateBookmark, bumpCapture],
	);

	const forgetContent = useCallback(
		(bookmark: Bookmark): void => {
			if (!bookmark.contentFetchedAt) return;
			captureErrors.current.delete(bookmark.id);
			bumpCapture();
			const now = Date.now();
			mutateBookmark(bookmark.id, (b) => {
				const { contentBlocks, contentFetchedAt, contentProvenance, ...rest } = b;
				return { ...rest, updatedAt: now };
			});
		},
		[mutateBookmark, bumpCapture],
	);

	// Fire-and-forget metadata scrape for a freshly-saved bookmark.
	const enrichBookmarkMetadata = useCallback(
		async (bookmark: Bookmark): Promise<void> => {
			const network = getBrainstorm()?.services?.network;
			if (!network) return;
			let preview: Awaited<ReturnType<typeof network.preview>>;
			try {
				preview = await network.preview({ url: bookmark.url });
			} catch {
				return;
			}
			mutateBookmark(bookmark.id, (b) => {
				const backfill = metadataBackfill(b, preview);
				if (!backfill) return b;
				return { ...b, ...backfill, updatedAt: Date.now() };
			});
		},
		[mutateBookmark],
	);

	// ── Compose / edit tags ─────────────────────────────────────────────
	const openCompose = useCallback(() => {
		openComposeBookmark({
			existing: bookmarksRef.current,
			idFactory: newBookmarkId,
			now: Date.now,
			downloadContentDefault: settings.downloadContentDefault,
			onSave: (bookmark, { downloadContent }) => {
				if (repository) void repository.save(bookmark);
				else setDemoBookmarks((list) => [bookmark, ...list]);
				// Enrich in the background, but in series — the metadata scrape and
				// the content capture each write the entity (and the scrape stores
				// cover/favicon assets too); running them concurrently piles writes
				// onto the shared entities.db connection and contends on the WAL lock
				// (F-278). One in-flight enrichment write at a time.
				void runSaveEnrichment(downloadContent, {
					scrapeMetadata: () => enrichBookmarkMetadata(bookmark),
					captureContent: () => captureContent(bookmark),
				});
				if (downloadContent !== settings.downloadContentDefault) {
					setSettings((prev) => {
						const next = { ...prev, downloadContentDefault: downloadContent };
						void persistKv(SETTINGS_KEY, next);
						return next;
					});
				}
			},
		});
	}, [settings, repository, enrichBookmarkMetadata, captureContent]);

	const openEditTagsFor = useCallback(
		(id: string) => {
			const bookmark = bookmarksRef.current.find((b) => b.id === id);
			if (!bookmark) return;
			openEditTags({
				bookmark,
				now: Date.now,
				onSave: (next) => {
					if (next === bookmark) return;
					if (repository) void repository.save(next);
					else setDemoBookmarks((list) => list.map((b) => (b.id === id ? next : b)));
				},
			});
		},
		[repository],
	);

	const openBookmarkIconPicker = useCallback(
		(bookmark: Bookmark) => {
			openIconPicker({
				value: bookmark.icon ?? null,
				onChange: (next) =>
					mutateBookmark(bookmark.id, (b) => ({ ...b, icon: next, updatedAt: Date.now() })),
			});
		},
		[mutateBookmark],
	);
	// The cover lives in the object ⋯ menu (parity with Notes): a coverless
	// bookmark shows no band, so the menu is the entry point to add one; an
	// existing cover is also editable here (and by clicking the band itself).
	const openBookmarkCoverPicker = useCallback(
		(bookmark: Bookmark) => {
			const covers = getBrainstorm()?.services?.covers;
			if (!covers) return;
			openCoverPicker({
				value: bookmark.cover ?? null,
				covers,
				onChange: (cover) =>
					mutateBookmark(bookmark.id, (b) => ({ ...b, cover, updatedAt: Date.now() })),
			});
		},
		[mutateBookmark],
	);

	// ── Selection / navigation actions ──────────────────────────────────
	const selectSurface = useCallback(
		(next: BookmarkSurface) => {
			setSurface(next);
			setSelectedTag(null);
			setActiveCollectionId(null);
			setOpenBookmarkId(null);
			recordNav({ surface: next, tag: null, openId: null, collectionId: null });
		},
		[recordNav],
	);
	const cycleSurface = useCallback(
		(delta: number) => {
			const i = BOOKMARK_SURFACES.indexOf(surface);
			const next =
				BOOKMARK_SURFACES[(i + delta + BOOKMARK_SURFACES.length) % BOOKMARK_SURFACES.length];
			if (next) selectSurface(next);
		},
		[surface, selectSurface],
	);
	const activateTagRow = useCallback(
		(row: TagRow | undefined) => {
			if (!row) return;
			const tag = row.kind === TagRowKind.All ? null : row.tag;
			setSurface(BookmarkSurface.Tags);
			setSelectedTag(tag);
			setActiveCollectionId(null);
			setOpenBookmarkId(null);
			recordNav({ surface: BookmarkSurface.Tags, tag, openId: null, collectionId: null });
		},
		[recordNav],
	);
	const openDetail = useCallback(
		(id: string) => {
			setOpenBookmarkId(id);
			recordNav({ surface, tag: selectedTag, openId: id, collectionId: activeCollectionId });
		},
		[recordNav, surface, selectedTag, activeCollectionId],
	);
	const selectCollection = useCallback(
		(id: string) => {
			setActiveCollectionId(id);
			setOpenBookmarkId(null);
			recordNav({ surface, tag: selectedTag, openId: null, collectionId: id });
		},
		[recordNav, surface, selectedTag],
	);

	// ── Collections persistence ─────────────────────────────────────────
	const saveCurrentViewAsCollection = useCallback(() => {
		const collection = smartCollectionFromView("", surface, selectedTag, {
			idFactory: newCollectionId,
			now: Date.now,
		});
		setCollections((prev) => {
			const next = [...prev, collection];
			void persistKv(COLLECTIONS_KEY, next);
			return next;
		});
		setActiveCollectionId(collection.id);
		recordNav({ surface, tag: selectedTag, openId: null, collectionId: collection.id });
	}, [surface, selectedTag, recordNav]);

	const removeCollection = useCallback((id: string) => {
		setCollections((prev) => {
			if (!prev.some((c) => c.id === id)) return prev;
			const next = prev.filter((c) => c.id !== id);
			void persistKv(COLLECTIONS_KEY, next);
			return next;
		});
		setActiveCollectionId((open) => (open === id ? null : open));
	}, []);

	// ── Tag board reorder ───────────────────────────────────────────────
	// The painted string-tag order (Untagged excluded) — the basis a
	// column-reorder drop mutates, so reordering survives lanes not yet in
	// `tagOrder`.
	const displayedTagOrderRef = useRef<string[]>([]);
	const reorderLane = useCallback((dragTag: string, targetTag: string) => {
		if (dragTag === targetTag) return;
		setTagOrder(() => {
			const next = reorderTags(displayedTagOrderRef.current, dragTag, targetTag);
			void persistKv(TAG_ORDER_KEY, next);
			return next;
		});
	}, []);
	const moveCardToLane = useCallback(
		(payload: CardDragPayload, toTag: string | null) => {
			if (payload.fromTag === toTag) return;
			mutateBookmark(payload.id, (b) => {
				const tags = retagForLaneMove(b.tags, payload.fromTag, toTag);
				if (tags === b.tags) return b;
				return { ...b, tags: [...tags], updatedAt: Date.now() };
			});
		},
		[mutateBookmark],
	);
	const onSetGrouping = useCallback((next: BookmarkGrouping) => {
		writeGroupingPref(next);
		setGrouping(next);
	}, []);

	// ── Dedup merge ─────────────────────────────────────────────────────
	const mergeAllDuplicates = useCallback(() => {
		const groups = findDuplicateGroups(bookmarksRef.current);
		if (groups.length === 0) return;
		const now = Date.now();
		let local = bookmarksRef.current;
		for (const group of groups) {
			const { merged, removedIds } = mergeBookmarks(group, now);
			const removed = new Set(removedIds);
			setOpenBookmarkId((open) => (open !== null && removed.has(open) ? merged.id : open));
			if (repository) {
				void repository.save(merged);
				for (const id of removedIds) void repository.remove(id);
			} else {
				local = local.map((b) => (b.id === merged.id ? merged : b)).filter((b) => !removed.has(b.id));
			}
		}
		if (!repository) setDemoBookmarks(local);
	}, [repository]);

	// ── Boot: load persisted settings / collections / tag order ──────────
	useEffect(() => {
		if (!runtime?.on) return;
		const sub = runtime.on("ready", () => {
			const storage = runtime.services?.storage;
			if (!storage) return;
			void storage
				.get<unknown>(SETTINGS_KEY)
				.then((raw) => setSettings(parseBookmarkSettings(raw)))
				.catch(() => {});
			void storage
				.get<unknown>(COLLECTIONS_KEY)
				.then((raw) => setCollections(parseCollections(raw)))
				.catch(() => {});
			void storage
				.get<unknown>(TAG_ORDER_KEY)
				.then((raw) => {
					if (Array.isArray(raw) && raw.every((x) => typeof x === "string")) {
						setTagOrder(raw as string[]);
					}
				})
				.catch(() => {});
		});
		return () => sub.unsubscribe();
	}, [runtime]);

	// Backfill the tags vocabulary at the app level (fires when the in-use tag
	// set changes); a failure only costs chip colours, never the render.
	const lastEnsuredTagsKey = useRef<string | null>(null);
	useEffect(() => {
		const properties = runtime?.services?.properties;
		if (!properties) return;
		const tags = uniqueTags(bookmarks).map((entry) => entry.tag);
		const key = tags.join(" ");
		if (key === lastEnsuredTagsKey.current) return;
		lastEnsuredTagsKey.current = key;
		ensureBookmarkTagsDictionary(properties, t("detail.tagsDictionaryName"), tags).catch((error) => {
			lastEnsuredTagsKey.current = null;
			console.warn("[bookmarks] tags dictionary ensure failed:", error);
		});
	}, [bookmarks, runtime]);

	// ── Sidebar resize handle ───────────────────────────────────────────
	const resizeRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		const handle = resizeRef.current;
		if (!handle) return;
		const r = attachResizable({
			handle,
			side: "left",
			defaultWidth: 248,
			min: 180,
			max: 420,
			storageKey: "bookmarks:sidebar-width",
			onWidth: (px) => {
				document.body.style.setProperty("--bookmarks-sidebar-width", `${px}px`);
			},
		});
		return () => r.destroy();
	}, []);

	// ── Toggles ─────────────────────────────────────────────────────────
	const toggleNav = useCallback(() => {
		setNavOpen((open) => {
			const next = !open;
			writePref(NAV_OPEN_KEY, next);
			return next;
		});
	}, []);
	const toggleProps = useCallback(() => {
		setPropsOpen((open) => {
			const next = !open;
			writePref(PROPS_OPEN_KEY, next);
			return next;
		});
	}, []);

	// ── Keyboard (shortcut registry, never raw e.key) ───────────────────
	useShortcut(
		"Mod+n",
		useCallback(() => openCompose(), [openCompose]),
	);
	useShortcut(
		"ArrowDown",
		useCallback(() => cycleSurface(1), [cycleSurface]),
	);
	useShortcut(
		"ArrowUp",
		useCallback(() => cycleSurface(-1), [cycleSurface]),
	);

	// ── Derived state ───────────────────────────────────────────────────
	const activeCollection = useMemo<Collection | null>(
		() =>
			activeCollectionId === null
				? null
				: (collections.find((c) => c.id === activeCollectionId) ?? null),
		[activeCollectionId, collections],
	);

	const visibleBookmarks = useMemo<Bookmark[]>(() => {
		if (activeCollection) {
			const members = collectionMembers(activeCollection, bookmarks);
			members.sort((a, b) => b.savedAt - a.savedAt);
			return members;
		}
		let list = filterForSurface(bookmarks, surface);
		if (surface === BookmarkSurface.Tags && selectedTag !== null) {
			const wanted = selectedTag;
			list =
				wanted === UNTAGGED
					? list.filter((b) => b.tags.length === 0)
					: list.filter((b) => b.tags.includes(wanted));
		}
		const sorted = [...list];
		sorted.sort((a, b) => b.savedAt - a.savedAt);
		return sorted;
	}, [activeCollection, bookmarks, surface, selectedTag]);

	const openBookmark = useMemo<Bookmark | null>(
		() => (openBookmarkId === null ? null : (bookmarks.find((b) => b.id === openBookmarkId) ?? null)),
		[openBookmarkId, bookmarks],
	);
	// The open bookmark vanished (removed elsewhere) — fall back to the list.
	useEffect(() => {
		if (openBookmarkId !== null && openBookmark === null) setOpenBookmarkId(null);
	}, [openBookmarkId, openBookmark]);

	const tagRows = useMemo<TagRow[]>(() => {
		const rows: TagRow[] = [{ kind: TagRowKind.All, tag: null, count: bookmarks.length }];
		for (const { tag, count } of uniqueTags(bookmarks)) {
			rows.push({ kind: TagRowKind.Tag, tag, count });
		}
		const untagged = bookmarks.filter((b) => b.tags.length === 0).length;
		if (untagged > 0) rows.push({ kind: TagRowKind.Untagged, tag: UNTAGGED, count: untagged });
		return rows;
	}, [bookmarks]);

	const duplicateGroups = useMemo(() => findDuplicateGroups(bookmarks), [bookmarks]);

	const showTagsOverview =
		activeCollection === null && surface === BookmarkSurface.Tags && selectedTag === null;
	const showCardList = openBookmark === null && !showTagsOverview && visibleBookmarks.length > 0;

	// ── Object-menu wiring (shared runtime) ─────────────────────────────
	const objectMenuRuntime = useCallback((): ObjectMenuRuntime => {
		const bs = getBrainstorm();
		if (!bs) return null;
		return {
			capabilities: bs.capabilities ?? [],
			services: {
				...(bs.services?.intents ? { intents: bs.services.intents } : {}),
				...(bs.services?.dashboard ? { dashboard: bs.services.dashboard } : {}),
			},
		};
	}, []);
	const menuChromeLabels = useCallback(
		(): Partial<ObjectMenuChromeLabels> => ({
			remove: t("menu.remove"),
			moreActions: t("action.moreActions"),
		}),
		[],
	);

	const bookmarkMenuContext = useCallback(
		(id: string): (() => OpenObjectMenuOptions | null) => {
			return () => {
				const bookmark = bookmarksRef.current.find((b) => b.id === id);
				if (!bookmark) return null;
				const runtimeForMenu = objectMenuRuntime();
				const cardSurface = surfaceFor(bookmark);
				const lifecycle: ObjectMenuExtraItem[] = [];
				if (cardSurface === BookmarkSurface.Inbox) {
					lifecycle.push({
						id: "toggle-read",
						label: t("action.markRead"),
						icon: SURFACE_ICON[BookmarkSurface.Read],
						run: () => toggleRead(bookmark.id, true),
					});
				} else if (cardSurface === BookmarkSurface.Read) {
					lifecycle.push({
						id: "toggle-read",
						label: t("action.markUnread"),
						icon: SURFACE_ICON[BookmarkSurface.Inbox],
						run: () => toggleRead(bookmark.id, false),
					});
				}
				lifecycle.push(
					cardSurface === BookmarkSurface.Archive
						? {
								id: "toggle-archive",
								label: t("action.unarchive"),
								icon: SURFACE_ICON[BookmarkSurface.Inbox],
								run: () => toggleArchive(bookmark.id, false),
							}
						: {
								id: "toggle-archive",
								label: t("action.archive"),
								icon: SURFACE_ICON[BookmarkSurface.Archive],
								run: () => toggleArchive(bookmark.id, true),
							},
				);
				const captureState = deriveCaptureState(
					Boolean(bookmark.contentFetchedAt),
					contentInFlight.current.has(bookmark.id),
					captureErrors.current.has(bookmark.id),
				);
				const actions = captureActionsFor(captureState);
				const contentItems: ObjectMenuExtraItem[] = [];
				if (actions.capture) {
					contentItems.push({
						id: "capture-content",
						label: t("detail.capture"),
						icon: IconName.Update,
						run: () => void captureContent(bookmark),
					});
				}
				if (actions.reload) {
					contentItems.push({
						id: "capture-content",
						label: t("detail.reload"),
						icon: IconName.Update,
						run: () => void captureContent(bookmark),
					});
				}
				if (actions.forget) {
					contentItems.push({
						id: "forget-content",
						label: t("detail.forget"),
						icon: IconName.Trash,
						run: () => forgetContent(bookmark),
					});
				}
				return {
					target: {
						entityId: bookmark.id,
						entityType: BOOKMARK_ENTITY_TYPE,
						label: bookmark.title || bookmark.url,
					},
					runtime: runtimeForMenu,
					labels: menuChromeLabels(),
					extraItems: [
						...lifecycle,
						...contentItems,
						{
							id: "change-icon",
							label: t("action.changeIcon"),
							icon: IconName.Palette,
							run: () => openBookmarkIconPicker(bookmark),
						},
						...(getBrainstorm()?.services?.covers
							? [
									{
										id: "cover",
										label: bookmark.cover ? t("detail.cover.edit") : t("detail.cover.add"),
										icon: IconName.Palette,
										run: () => openBookmarkCoverPicker(bookmark),
									},
								]
							: []),
						{
							id: "edit-tags",
							label: t("action.editTags"),
							icon: IconName.Tag,
							run: () => openEditTagsFor(bookmark.id),
						},
					],
					...(repository ? { onRemove: () => removeBookmark(bookmark.id) } : {}),
				};
			};
		},
		[
			objectMenuRuntime,
			menuChromeLabels,
			toggleRead,
			toggleArchive,
			captureContent,
			forgetContent,
			openBookmarkIconPicker,
			openBookmarkCoverPicker,
			openEditTagsFor,
			removeBookmark,
			repository,
		],
	);

	// The active collection's header ⋯ — its only action mirrors the sidebar
	// row's remove.
	const collectionMenuContext = useCallback((): OpenObjectMenuOptions | null => {
		const live = activeCollection;
		if (!live) return null;
		return {
			target: { entityId: live.id, entityType: "brainstorm/List/v1", label: live.name },
			runtime: objectMenuRuntime(),
			omitOpen: true,
			labels: menuChromeLabels(),
			onRemove: () => removeCollection(live.id),
		};
	}, [activeCollection, objectMenuRuntime, menuChromeLabels, removeCollection]);

	// ── Header ──────────────────────────────────────────────────────────
	const mainTitle = useMemo(() => {
		if (openBookmark) return openBookmark.title || openBookmark.url;
		if (activeCollection) return activeCollection.name;
		if (surface === BookmarkSurface.Tags && selectedTag !== null) {
			return selectedTag === UNTAGGED
				? t("main.tag.untagged")
				: t("main.tag.named", { tag: selectedTag });
		}
		return t(SURFACE_MESSAGE_KEY[surface]);
	}, [openBookmark, activeCollection, surface, selectedTag]);

	const headerMenuContext = useMemo<(() => OpenObjectMenuOptions | null) | null>(() => {
		if (openBookmark) return bookmarkMenuContext(openBookmark.id);
		if (activeCollection) return collectionMenuContext;
		return null;
	}, [openBookmark, activeCollection, bookmarkMenuContext, collectionMenuContext]);

	return (
		<>
			<header className="app-header">
				<div className="app-header__left">
					<NavButtons history={nav} onNavigate={applyNavLoc} />
					<span
						className="app-header__title"
						// When a bookmark is open the title IS the object's identity — make it
						// the right-click trigger for the same object menu the ⋯ opens.
						{...(openBookmark ? { [ENTITY_ID_ATTR]: openBookmark.id } : {})}
						onContextMenu={(event) => {
							if (!headerMenuContext) return;
							const ctx = headerMenuContext();
							if (!ctx) return;
							event.preventDefault();
							void openObjectMenu({ x: event.clientX, y: event.clientY }, ctx);
						}}
					>
						{mainTitle}
					</span>
				</div>
				<div className="app-header__right">
					<button
						type="button"
						className="bookmarks__header-btn bookmarks__header-add"
						data-bs-tooltip={t("action.addBookmark")}
						aria-label={t("action.addBookmark")}
						onClick={openCompose}
					>
						<Icon name={IconName.Plus} size={18} />
					</button>
					{openBookmark ? (
						<a
							className="bookmarks__header-btn"
							href={openBookmark.url}
							target="_blank"
							rel="noopener noreferrer"
							title={t("detail.openOriginal")}
							aria-label={t("detail.openOriginal")}
						>
							<Icon name={IconName.OpenExternal} size={18} />
						</a>
					) : null}
					<PanelToggleButton
						side={PanelSide.Left}
						open={navOpen}
						onClick={toggleNav}
						labels={{ show: t("header.sidebar.show"), hide: t("header.sidebar.hide") }}
					/>
					{showTagsOverview ? <GroupByButton active={grouping} onSet={onSetGrouping} /> : null}
					{openBookmark ? (
						<PanelToggleButton
							side={PanelSide.Right}
							open={propsOpen}
							onClick={toggleProps}
							labels={{ show: t("header.inspector.show"), hide: t("header.inspector.hide") }}
						/>
					) : null}
					<ObjectMenuMoreButton
						className="bookmarks__header-more"
						moreActionsLabel={t("action.moreActions")}
						context={headerMenuContext ?? (() => null)}
						disabled={!headerMenuContext}
					/>
				</div>
			</header>

			<main className="bookmarks" data-nav-open={String(navOpen)}>
				<Sidebar
					surface={surface}
					selectedTag={selectedTag}
					activeCollectionId={activeCollectionId}
					collections={collections}
					bookmarks={bookmarks}
					tagRows={tagRows}
					onSelectSurface={selectSurface}
					onActivateTagRow={activateTagRow}
					onSelectCollection={selectCollection}
					onSaveCollection={saveCurrentViewAsCollection}
					onRemoveCollection={removeCollection}
				/>
				<MainPane
					openBookmark={openBookmark}
					surface={surface}
					selectedTag={selectedTag}
					activeCollection={activeCollection}
					showTagsOverview={showTagsOverview}
					showCardList={showCardList}
					grouping={grouping}
					visibleBookmarks={visibleBookmarks}
					duplicateGroups={duplicateGroups}
					title={mainTitle}
					tagOrder={tagOrder}
					displayedTagOrderRef={displayedTagOrderRef}
					propsOpen={propsOpen}
					onToggleProps={toggleProps}
					onOpenDetail={openDetail}
					onAdd={openCompose}
					onMergeDuplicates={mergeAllDuplicates}
					menuContextFor={bookmarkMenuContext}
					onMoveCardToLane={moveCardToLane}
					onReorderLane={reorderLane}
					mutateBookmark={mutateBookmark}
					captureContent={captureContent}
					contentInFlight={contentInFlight}
					captureErrors={captureErrors}
				/>
				<div
					ref={resizeRef}
					className="bookmarks__resize"
					role="separator"
					aria-orientation="vertical"
					aria-label={t("sidebar.resize")}
					tabIndex={0}
				/>
			</main>
		</>
	);
}

/** Persist a kv value, fire-and-forget (a write failure leaves the in-memory
 *  value for the session). */
function persistKv(key: string, value: unknown): Promise<void> {
	const storage = getBrainstorm()?.services?.storage;
	if (!storage) return Promise.resolve();
	return storage.put(key, value).catch(() => {});
}

// ── Group-by header control ───────────────────────────────────────────────

/** The "Group by ▾" header button — opens the shared anchored menu listing
 *  every grouping axis, the active one checked. Shown only on the Tag board
 *  surface; replaces the hardcoded group-by-tags board with a one-click pick
 *  of any axis. Mirrors Tasks' `renderGroupByPicker`. */
function GroupByButton({
	active,
	onSet,
}: {
	active: BookmarkGrouping;
	onSet: (grouping: BookmarkGrouping) => void;
}) {
	const buttonRef = useRef<HTMLButtonElement | null>(null);
	const openMenu = useCallback(() => {
		const button = buttonRef.current;
		if (!button) return;
		const rect = button.getBoundingClientRect();
		void openAnchoredMenu(
			{ x: rect.left, y: rect.bottom + 4 },
			BOOKMARK_GROUPINGS.map((grouping) => ({
				label: t(GROUP_LABEL_KEY[grouping]),
				...(grouping === active ? { icon: IconName.Check } : {}),
				onSelect: () => onSet(grouping),
			})),
			{ menuLabel: t("group.menuLabel"), anchor: button },
		);
	}, [active, onSet]);
	return (
		<button
			ref={buttonRef}
			type="button"
			className="bookmarks__header-btn bookmarks__group-by"
			onClick={openMenu}
		>
			{t("header.groupBy", { axis: t(GROUP_LABEL_KEY[active]) })}
		</button>
	);
}

// ── Sidebar ─────────────────────────────────────────────────────────────

type SidebarProps = {
	surface: BookmarkSurface;
	selectedTag: string | null;
	activeCollectionId: string | null;
	collections: Collection[];
	bookmarks: Bookmark[];
	tagRows: TagRow[];
	onSelectSurface: (surface: BookmarkSurface) => void;
	onActivateTagRow: (row: TagRow | undefined) => void;
	onSelectCollection: (id: string) => void;
	onSaveCollection: () => void;
	onRemoveCollection: (id: string) => void;
};

function Sidebar({
	surface,
	selectedTag,
	activeCollectionId,
	collections,
	bookmarks,
	tagRows,
	onSelectSurface,
	onActivateTagRow,
	onSelectCollection,
	onSaveCollection,
	onRemoveCollection,
}: SidebarProps) {
	const scrollRef = useRef<HTMLElement | null>(null);
	const tagListRef = useRef<HTMLUListElement | null>(null);

	const surfaceCount = useCallback(
		(s: BookmarkSurface) => filterForSurface(bookmarks, s).length,
		[bookmarks],
	);

	// The windowed tag list shares the sidebar's single scroll viewport (no
	// nested scrollbar): rows are positioned over a spacer inside the in-flow
	// `tagListRef` host below the static nav/collections.
	const virtualizer = useVirtualizer({
		count: tagRows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => TAG_ROW_HEIGHT,
		getItemKey: (index) => {
			const row = tagRows[index];
			if (!row) return index;
			return row.kind === TagRowKind.All ? "§all" : (row.tag ?? `§${row.kind}`);
		},
		// The windowed region starts below the static nav/collections/header, so
		// the virtualizer needs that offset to map scroll position to tag indices.
		scrollMargin: tagListRef.current?.offsetTop ?? 0,
		overscan: 8,
	});

	// KBN-A-bookmarks (tag list): a vertical listbox tracking the active row via
	// `aria-activedescendant` (the active row may be windowed out of the DOM).
	// The tag-row's inner button owns `aria-selected` for the active FILTER, so
	// the cursor uses `SelectionAttribute.None` to avoid colliding meanings — the
	// keyboard cursor is independent of the active filter (arrow moves the
	// cursor, Enter applies the filter), so it lives in local state, clamped to
	// the row count after a filter/mutation shrinks the list.
	const [tagCursor, setTagCursor] = useState(0);
	const clampedTagCursor = clampCursor(tagCursor, tagRows.length);
	const activateAt = useCallback(
		(index: number) => {
			onActivateTagRow(tagRows[index]);
			virtualizer.scrollToIndex(index);
		},
		[tagRows, onActivateTagRow, virtualizer],
	);
	const { containerProps, getItemProps } = useCompositeKeyboard({
		orientation: Orientation.Vertical,
		count: tagRows.length,
		activeIndex: clampedTagCursor,
		onActiveIndexChange: (i) => {
			setTagCursor(i);
			virtualizer.scrollToIndex(i);
		},
		onActivate: activateAt,
		useAriaActiveDescendant: true,
		selectionAttribute: SelectionAttribute.None,
	});

	return (
		<aside className="bookmarks__sidebar" ref={scrollRef}>
			<nav className="bookmarks__nav" aria-label={t("nav.surfaces")}>
				{BOOKMARK_SURFACES.map((s) => (
					<button
						key={s}
						type="button"
						className="bookmarks__nav-btn"
						aria-selected={surface === s}
						onClick={() => onSelectSurface(s)}
					>
						<span className="bookmarks__nav-glyph" aria-hidden="true">
							<Icon name={SURFACE_ICON[s]} size={14} />
						</span>
						<span className="bookmarks__nav-label">{t(SURFACE_MESSAGE_KEY[s])}</span>
						<CountBadge count={surfaceCount(s)} />
					</button>
				))}
			</nav>

			<div className="bookmarks__collections">
				<div className="bookmarks__sidebar-section bookmarks__collections-head">
					<span className="bookmarks__collections-title">{t("collections.title")}</span>
					<button
						type="button"
						className="bookmarks__collection-save"
						data-bs-tooltip={t("collections.save")}
						aria-label={t("collections.save")}
						onClick={onSaveCollection}
					>
						<Icon name={IconName.Plus} size={14} />
					</button>
				</div>
				{collections.length === 0 ? (
					<span className="bookmarks__collections-empty">{t("collections.empty")}</span>
				) : (
					<ul className="bookmarks__collection-list">
						{collections.map((collection) => (
							<li key={collection.id} className="bookmarks__collection-item">
								<button
									type="button"
									className="bookmarks__collection-btn"
									aria-selected={activeCollectionId === collection.id}
									onClick={() => onSelectCollection(collection.id)}
								>
									<span className="bookmarks__nav-glyph" aria-hidden="true">
										<Icon name={IconName.Folder} size={14} />
									</span>
									<span className="bookmarks__collection-label">{collection.name}</span>
									<CountBadge count={collectionCount(collection, bookmarks)} />
								</button>
								<button
									type="button"
									className="bookmarks__collection-remove"
									data-bs-tooltip={t("collections.remove")}
									aria-label={t("collections.remove")}
									onClick={(e) => {
										e.stopPropagation();
										onRemoveCollection(collection.id);
									}}
								>
									<Icon name={IconName.Close} size={12} />
								</button>
							</li>
						))}
					</ul>
				)}
			</div>

			<h3 className="bookmarks__sidebar-section">{t("sidebar.tags")}</h3>
			<ul
				{...containerProps}
				ref={tagListRef}
				className="bookmarks__tag-list"
				aria-label={t("sidebar.tags")}
				style={{ height: virtualizer.getTotalSize() }}
			>
				{virtualizer.getVirtualItems().map((virtualRow) => {
					const row = tagRows[virtualRow.index];
					if (!row) return null;
					const isSelected =
						(row.kind === TagRowKind.All && selectedTag === null) || row.tag === selectedTag;
					const label =
						row.kind === TagRowKind.All
							? t("tag.all")
							: row.kind === TagRowKind.Untagged
								? t("tag.untagged")
								: (row.tag ?? "");
					return (
						<li
							key={virtualRow.key}
							{...getItemProps(virtualRow.index)}
							className="bookmarks__tag-list-item"
							style={{
								position: "absolute",
								top: 0,
								left: 0,
								width: "100%",
								height: virtualRow.size,
								transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
							}}
						>
							<button
								type="button"
								className="bookmarks__tag-list-btn"
								tabIndex={-1}
								aria-selected={isSelected}
								onClick={() => onActivateTagRow(row)}
							>
								<span className="bookmarks__nav-glyph" aria-hidden="true">
									<Icon name={IconName.Tag} size={14} />
								</span>
								<span className="bookmarks__tag-list-label">{label}</span>
								<CountBadge count={row.count} />
							</button>
						</li>
					);
				})}
			</ul>
		</aside>
	);
}

// ── Main pane ───────────────────────────────────────────────────────────

type MainPaneProps = {
	openBookmark: Bookmark | null;
	surface: BookmarkSurface;
	selectedTag: string | null;
	activeCollection: Collection | null;
	showTagsOverview: boolean;
	showCardList: boolean;
	grouping: BookmarkGrouping;
	visibleBookmarks: Bookmark[];
	duplicateGroups: DuplicateGroup[];
	title: string;
	tagOrder: string[];
	displayedTagOrderRef: React.MutableRefObject<string[]>;
	propsOpen: boolean;
	onToggleProps: () => void;
	onOpenDetail: (id: string) => void;
	onAdd: () => void;
	onMergeDuplicates: () => void;
	menuContextFor: (id: string) => () => OpenObjectMenuOptions | null;
	onMoveCardToLane: (payload: CardDragPayload, toTag: string | null) => void;
	onReorderLane: (dragTag: string, targetTag: string) => void;
	mutateBookmark: (id: string, fn: (b: Bookmark) => Bookmark) => void;
	captureContent: (bookmark: Bookmark) => Promise<void>;
	contentInFlight: React.MutableRefObject<Set<string>>;
	captureErrors: React.MutableRefObject<Set<string>>;
};

function MainPane(props: MainPaneProps) {
	const { openBookmark } = props;
	if (openBookmark) return <DetailPane {...props} openBookmark={openBookmark} />;

	const { surface, selectedTag, activeCollection, title, visibleBookmarks, duplicateGroups } = props;
	const subtitle = plural(visibleBookmarks.length, "main.subtitle.one", "main.subtitle.many");

	const emptyMessage = (): string => {
		if (activeCollection) return t("empty.collection");
		switch (surface) {
			case BookmarkSurface.Inbox:
				return t("empty.inbox");
			case BookmarkSurface.Read:
				return t("empty.read");
			case BookmarkSurface.Archive:
				return t("empty.archive");
			case BookmarkSurface.Tags:
				return selectedTag ? t("empty.tags.named", { tag: selectedTag }) : t("empty.tags.none");
		}
	};

	const mainClass = props.showCardList ? "bookmarks__main bookmarks__main--list" : "bookmarks__main";

	const header = (
		<div className="bookmarks__main-header">
			<span className="bookmarks__main-title">{title}</span>
			<span className="bookmarks__main-subtitle">{subtitle}</span>
		</div>
	);
	const banner =
		duplicateGroups.length > 0 ? (
			<DuplicateBanner groups={duplicateGroups} onMerge={props.onMergeDuplicates} />
		) : null;

	// The flat list owns its own scroll viewport, so its header + dedup banner
	// ride INSIDE that viewport (they scroll away with the cards and align to the
	// same 72ch reading column). The board / empty surfaces scroll the whole pane,
	// so they keep the header in the section directly.
	if (props.showCardList && visibleBookmarks.length > 0) {
		return (
			<section className={mainClass}>
				<CardList
					bookmarks={visibleBookmarks}
					surface={surface}
					onOpenDetail={props.onOpenDetail}
					menuContextFor={props.menuContextFor}
					header={header}
					banner={banner}
				/>
			</section>
		);
	}

	return (
		<section className={mainClass}>
			{header}
			{banner}
			{visibleBookmarks.length === 0 ? (
				<EmptyState
					className="bookmarks__empty"
					icon={IconName.KindLink}
					title={emptyMessage()}
					{...(surface === BookmarkSurface.Read || surface === BookmarkSurface.Archive
						? {
								// Adding a bookmark lands in the INBOX — offering it here
								// promised the wrong repair (F-450, Marcus session 909).
								hint: t(surface === BookmarkSurface.Read ? "empty.read.hint" : "empty.archive.hint"),
							}
						: {
								action: (
									<button type="button" className="bs-btn" data-bs-primary="" onClick={props.onAdd}>
										{t("action.addBookmark")}
									</button>
								),
							})}
				/>
			) : (
				<TagBoards
					bookmarks={visibleBookmarks}
					surface={surface}
					grouping={props.grouping}
					tagOrder={props.tagOrder}
					displayedTagOrderRef={props.displayedTagOrderRef}
					onOpenDetail={props.onOpenDetail}
					menuContextFor={props.menuContextFor}
					onMoveCardToLane={props.onMoveCardToLane}
					onReorderLane={props.onReorderLane}
				/>
			)}
		</section>
	);
}

function DetailPane(props: MainPaneProps & { openBookmark: Bookmark }) {
	const { openBookmark, propsOpen, onToggleProps, mutateBookmark } = props;
	const runtime = useMemo(() => getBrainstorm(), []);
	const captureState = deriveCaptureState(
		Boolean(openBookmark.contentFetchedAt),
		props.contentInFlight.current.has(openBookmark.id),
		props.captureErrors.current.has(openBookmark.id),
	);
	return (
		<section className="bookmarks__main bookmarks__detail-island">
			<YDocProvider resolver={getBookmarkResolver()}>
				<BookmarkDetail
					bookmark={openBookmark}
					onPropertyChange={(partial) =>
						mutateBookmark(openBookmark.id, (b) => ({ ...b, ...partial, updatedAt: Date.now() }))
					}
					properties={runtime?.services?.properties ?? null}
					covers={runtime?.services?.covers ?? null}
					showProperties={propsOpen}
					onToggleProperties={onToggleProps}
					captureState={captureState}
					onCapture={() => void props.captureContent(openBookmark)}
				/>
			</YDocProvider>
		</section>
	);
}

function DuplicateBanner({
	groups,
	onMerge,
}: {
	groups: DuplicateGroup[];
	onMerge: () => void;
}) {
	const redundant = groups.reduce((n, g) => n + g.bookmarks.length - 1, 0);
	return (
		<div className="bookmarks__dedup-banner" role="note">
			<span className="bookmarks__dedup-label">
				{plural(redundant, "dedup.banner.one", "dedup.banner.many")}
			</span>
			<button type="button" className="bookmarks__dedup-merge" onClick={onMerge}>
				{t("dedup.merge")}
			</button>
		</div>
	);
}

// ── Flat (virtualized) card list ─────────────────────────────────────────

function CardList({
	bookmarks,
	surface,
	onOpenDetail,
	menuContextFor,
	header,
	banner,
}: {
	bookmarks: Bookmark[];
	surface: BookmarkSurface;
	onOpenDetail: (id: string) => void;
	menuContextFor: (id: string) => () => OpenObjectMenuOptions | null;
	/** The pane title + dedup banner ride inside the scroll viewport so they
	 *  scroll away with the cards and align to the 72ch reading column. */
	header?: React.ReactNode;
	banner?: React.ReactNode;
}) {
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const virtualizer = useVirtualizer({
		count: bookmarks.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => CARD_ROW_ESTIMATE,
		getItemKey: (index) => bookmarks[index]?.id ?? index,
		overscan: 6,
	});

	// KBN-A-bookmarks (card list): arrow moves the cursor (without opening),
	// Enter opens the active bookmark's detail. The list is virtualized, so it
	// keeps focus on the container and tracks the active row via
	// `aria-activedescendant` (the active row may be windowed out of the DOM).
	const [cursor, setCursor] = useState(0);
	const clampedCursor = clampCursor(cursor, bookmarks.length);
	const activateAt = useCallback(
		(index: number) => {
			const bookmark = bookmarks[index];
			if (bookmark) onOpenDetail(bookmark.id);
		},
		[bookmarks, onOpenDetail],
	);
	const { containerProps, getItemProps } = useCompositeKeyboard({
		orientation: Orientation.Vertical,
		count: bookmarks.length,
		activeIndex: clampedCursor,
		onActiveIndexChange: (i) => {
			setCursor(i);
			virtualizer.scrollToIndex(i);
		},
		onActivate: activateAt,
		useAriaActiveDescendant: true,
		selectionAttribute: SelectionAttribute.None,
	});

	return (
		<div className="bookmarks__card-scroll" ref={scrollRef}>
			{header}
			{banner}
			<ul
				{...containerProps}
				className="bookmarks__cards"
				aria-label={t("a11y.cardList")}
				style={{ position: "relative", height: virtualizer.getTotalSize() }}
			>
				{virtualizer.getVirtualItems().map((virtualRow) => {
					const bookmark = bookmarks[virtualRow.index];
					if (!bookmark) return null;
					const itemProps = getItemProps(virtualRow.index);
					return (
						<div
							key={virtualRow.key}
							className="bookmarks__card-row"
							ref={(el) => virtualizer.measureElement(el)}
							data-index={virtualRow.index}
							style={{
								position: "absolute",
								top: 0,
								left: 0,
								width: "100%",
								transform: `translateY(${virtualRow.start}px)`,
							}}
						>
							<BookmarkCard
								bookmark={bookmark}
								surface={surface}
								onOpen={onOpenDetail}
								menuContext={menuContextFor(bookmark.id)}
								listItemProps={itemProps}
							/>
						</div>
					);
				})}
			</ul>
		</div>
	);
}

// ── Tag Kanban board ──────────────────────────────────────────────────────

function TagBoards({
	bookmarks,
	surface,
	grouping,
	tagOrder,
	displayedTagOrderRef,
	onOpenDetail,
	menuContextFor,
	onMoveCardToLane,
	onReorderLane,
}: {
	bookmarks: Bookmark[];
	surface: BookmarkSurface;
	grouping: BookmarkGrouping;
	tagOrder: string[];
	displayedTagOrderRef: React.MutableRefObject<string[]>;
	onOpenDetail: (id: string) => void;
	menuContextFor: (id: string) => () => OpenObjectMenuOptions | null;
	onMoveCardToLane: (payload: CardDragPayload, toTag: string | null) => void;
	onReorderLane: (dragTag: string, targetTag: string) => void;
}) {
	const [draggingId, setDraggingId] = useState<string | null>(null);
	// Lane drag-reorder + card-drag-to-lane (which mutates tags) only make
	// sense on the Tags axis — "move a card into a domain lane" is meaningless.
	// The other axes render read-only lanes.
	const tagsMode = grouping === BookmarkGrouping.Tags;
	// Column order is stable across renders: the manual order leads, then the
	// last painted sequence holds every other lane in place — so moving a card
	// between lanes (which shifts counts) doesn't reshuffle the columns.
	const lanes = useMemo(
		() =>
			buildBoardLanes(bookmarks, grouping, {
				order: [...tagOrder, ...displayedTagOrderRef.current],
				host: (url) => domainFromUrl(url),
				now: Date.now(),
				labels: BOARD_LANE_LABELS,
			}),
		[bookmarks, grouping, tagOrder, displayedTagOrderRef],
	);
	// Remember the painted string-key order so a column-reorder drop mutates the
	// actual visible sequence (incl. lanes not yet in `tagOrder`). Only the
	// reorderable Tags axis feeds this back.
	useEffect(() => {
		if (!tagsMode) return;
		displayedTagOrderRef.current = lanes
			.map((lane) => lane.key)
			.filter((key): key is string => key !== null);
	}, [lanes, tagsMode, displayedTagOrderRef]);

	return (
		<div className="bookmarks__tag-boards">
			{lanes.map((lane) => (
				<TagBoard
					key={lane.key ?? "__untagged__"}
					lane={lane}
					surface={surface}
					reorderable={tagsMode}
					draggingId={draggingId}
					onOpenDetail={onOpenDetail}
					menuContextFor={menuContextFor}
					onMoveCardToLane={onMoveCardToLane}
					onReorderLane={onReorderLane}
					onSetDragging={setDraggingId}
				/>
			))}
		</div>
	);
}

function TagBoard({
	lane,
	surface,
	reorderable,
	draggingId,
	onOpenDetail,
	menuContextFor,
	onMoveCardToLane,
	onReorderLane,
	onSetDragging,
}: {
	lane: BoardLane;
	surface: BookmarkSurface;
	/** When false (a non-Tags axis), the lane is read-only — no drag handle,
	 *  no cross-lane card drop. Card click-to-open stays available. */
	reorderable: boolean;
	draggingId: string | null;
	onOpenDetail: (id: string) => void;
	menuContextFor: (id: string) => () => OpenObjectMenuOptions | null;
	onMoveCardToLane: (payload: CardDragPayload, toTag: string | null) => void;
	onReorderLane: (dragTag: string, targetTag: string) => void;
	onSetDragging: (id: string | null) => void;
}) {
	const [dropTarget, setDropTarget] = useState(false);
	const [reorderTarget, setReorderTarget] = useState(false);

	// On the Tags axis a lane's `key` IS the tag the card-move retags to; the
	// heading is derived from it. The other axes carry a pre-localized `label`.
	const tag = lane.key;
	const heading = lane.label ?? tag ?? t("tag.untagged");
	const laneDraggable = reorderable && tag !== null;

	const onDragOver = (e: ReactDragEvent) => {
		if (!reorderable) return;
		const types = e.dataTransfer?.types;
		if (!types) return;
		if (types.includes(CARD_DND_TYPE)) {
			e.preventDefault();
			e.dataTransfer.dropEffect = "move";
			setDropTarget(true);
			return;
		}
		// A lane can't be reordered onto the pinned Untagged lane.
		if (types.includes(LANE_DND_TYPE) && tag !== null) {
			e.preventDefault();
			e.dataTransfer.dropEffect = "move";
			setReorderTarget(true);
		}
	};
	const clearHints = () => {
		setDropTarget(false);
		setReorderTarget(false);
	};
	const onDragLeave = (e: ReactDragEvent) => {
		// Only clear when the pointer truly leaves the lane, not on the
		// child-to-child dragleave that fires while moving across cards.
		if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
		clearHints();
	};
	const onDrop = (e: ReactDragEvent) => {
		if (!reorderable) return;
		clearHints();
		const data = e.dataTransfer;
		if (!data) return;
		const cardRaw = data.getData(CARD_DND_TYPE);
		if (cardRaw) {
			e.preventDefault();
			const payload = parseCardPayload(cardRaw);
			if (payload) onMoveCardToLane(payload, tag);
			onSetDragging(null);
			return;
		}
		const dragTag = data.getData(LANE_DND_TYPE);
		if (dragTag && tag !== null) {
			e.preventDefault();
			onReorderLane(dragTag, tag);
			onSetDragging(null);
		}
	};

	let className = "bookmarks__tag-board";
	if (dropTarget) className += " bookmarks__tag-board--drop-target";
	if (reorderTarget) className += " bookmarks__tag-board--reorder-target";

	return (
		<section
			className={className}
			{...(reorderable && tag !== null ? { "data-lane-tag": tag } : {})}
			onDragOver={onDragOver}
			onDragLeave={onDragLeave}
			onDrop={onDrop}
		>
			<h4
				className={
					laneDraggable
						? "bookmarks__tag-board-head bookmarks__tag-board-head--draggable"
						: "bookmarks__tag-board-head"
				}
				draggable={laneDraggable}
				onDragStart={
					laneDraggable
						? (e) => {
								if (tag === null) return;
								e.dataTransfer.setData(LANE_DND_TYPE, tag);
								e.dataTransfer.effectAllowed = "move";
							}
						: undefined
				}
			>
				<span className="bookmarks__tag-board-label">{heading}</span>
				<span className="bookmarks__tag-board-count">{lane.bookmarks.length}</span>
			</h4>
			<ul className="bookmarks__cards">
				{lane.bookmarks.map((bookmark) => (
					<BookmarkCard
						key={bookmark.id}
						bookmark={bookmark}
						surface={surface}
						onOpen={onOpenDetail}
						menuContext={menuContextFor(bookmark.id)}
						draggable={reorderable}
						dragging={draggingId === bookmark.id}
						{...(reorderable
							? {
									onCardDragStart: (e: ReactDragEvent) => {
										e.dataTransfer.setData(CARD_DND_TYPE, JSON.stringify({ id: bookmark.id, fromTag: tag }));
										e.dataTransfer.effectAllowed = "move";
										onSetDragging(bookmark.id);
									},
									onCardDragEnd: () => onSetDragging(null),
								}
							: {})}
					/>
				))}
			</ul>
		</section>
	);
}
