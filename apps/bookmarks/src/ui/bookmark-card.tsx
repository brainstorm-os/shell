/**
 * `BookmarkCard` — one bookmark row in the flat list / a tag-board lane. The
 * cover thumbnail + favicon badge + icon come from the imperative SDK factories
 * (`createEntityCoverElement` / `createEntityIconElement`), mounted behind the
 * shared `useDomChild` ref boundary.
 *
 * Every per-bookmark action lives in the hover-revealed ⋯ object menu
 * (`<ObjectMenuMoreButton>` in the actions corner); right-click anywhere on the
 * card opens the SAME shared menu (`openObjectMenu` on the `<li>`'s
 * `onContextMenu`), and clicking the card background opens the detail. Keeping
 * the row a bare `<li>` (no wrapper) preserves the `<ul>/<li>` flex layout the
 * imperative version relied on.
 */

import { CoverKind } from "@brainstorm/sdk-types";
import type { CompositeItemProps } from "@brainstorm/sdk/a11y";
import { createEntityCoverElement } from "@brainstorm/sdk/entity-cover";
import { createEntityIconElement } from "@brainstorm/sdk/entity-icon";
import { Icon, IconName } from "@brainstorm/sdk/icon";
import { ObjectMenuMoreButton, openObjectMenu } from "@brainstorm/sdk/object-menu";
import type { ObjectMenuContext } from "@brainstorm/sdk/object-menu";
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from "react";
import { t } from "../i18n/manifest";
import { CONTENT_KIND_LABEL_KEY, classifyMediaType, hasDistinctKind } from "../logic/content-kind";
import { surfaceFor } from "../logic/surface-for";
import { domainFromUrl } from "../logic/url-parse";
import { BOOKMARK_ENTITY_TYPE, type Bookmark } from "../types/bookmark";
import { BookmarkSurface } from "../types/surface";
import { ENTITY_ID_ATTR, ENTITY_TYPE_ATTR } from "./delegated-object-menu";
import { useDomChild } from "./use-dom-child";

/** Card cover aspect (landscape) — wide enough to read as a preview image
 *  rather than an icon. Mirrors `.bookmarks__card-thumb` (96×64) in the CSS. */
const COVER_ASPECT = 96 / 64;

const SURFACE_TAG_CLASS: Readonly<Record<BookmarkSurface, string>> = {
	[BookmarkSurface.Inbox]: "bookmarks__surface-tag--inbox",
	[BookmarkSurface.Read]: "bookmarks__surface-tag--read",
	[BookmarkSurface.Archive]: "bookmarks__surface-tag--archive",
	[BookmarkSurface.Tags]: "bookmarks__surface-tag--tags",
};

const SURFACE_TAG_LABEL: Readonly<Record<BookmarkSurface, Parameters<typeof t>[0]>> = {
	[BookmarkSurface.Inbox]: "surface.inbox",
	[BookmarkSurface.Read]: "surface.read",
	[BookmarkSurface.Archive]: "surface.archive",
	[BookmarkSurface.Tags]: "surface.tags",
};

export type BookmarkCardProps = {
	bookmark: Bookmark;
	/** The surface the list is showing — drives whether a per-card surface pill
	 *  is worth showing (only in the Tags views, where lanes mix surfaces). */
	surface: BookmarkSurface;
	/** Open the in-app detail view for this bookmark. */
	onOpen: (id: string) => void;
	/** Object-menu context resolved at open time (right-click + ⋯). `null` →
	 *  the trigger is inert (preview mode, no repository). */
	menuContext: () => ObjectMenuContext;
	/** Board-lane drag wiring — present only when the card lives in a tag board. */
	draggable?: boolean;
	onCardDragStart?: (event: ReactDragEvent) => void;
	onCardDragEnd?: () => void;
	dragging?: boolean;
	/** Composite-keyboard props (role / id / aria) for the flat-list cursor.
	 *  Omitted in the tag board (lanes aren't a single keyboard list). */
	listItemProps?: CompositeItemProps;
};

/** Build the bookmark's favicon / icon as a DOM node at a given pixel size,
 *  or `null` when the bookmark has neither. Shared by the corner badge (16px,
 *  over a cover) and the bare-tile mark (larger, when there's no cover). */
function buildFaviconNode(bookmark: Bookmark, size: number): HTMLElement | null {
	if (bookmark.icon) return createEntityIconElement(bookmark.icon, { size });
	if (bookmark.faviconUrl) {
		const img = document.createElement("img");
		img.className = "bookmarks__card-favicon";
		img.src = bookmark.faviconUrl;
		img.alt = "";
		img.draggable = false;
		img.width = size;
		img.height = size;
		return img;
	}
	return null;
}

/** The square card thumbnail. When the bookmark has its OWN cover (an explicit
 *  cover or a captured `coverImageUrl`) it paints that, with the favicon/icon
 *  badged into the corner. When it doesn't, we deliberately do NOT fall back to
 *  the id-seeded gradient here (a wall of meaningless coloured blocks in a link
 *  list reads as noise) — instead a quiet neutral tile shows just the favicon,
 *  or a globe glyph when even that is missing. */
function CardThumb({ bookmark }: { bookmark: Bookmark }) {
	const cover =
		bookmark.cover ??
		(bookmark.coverImageUrl ? { kind: CoverKind.Image, value: bookmark.coverImageUrl } : null);
	// The `cover` object is rebuilt every render (the `??` fallback is a fresh
	// literal), so keying the imperative mount on it would tear down + relay the
	// <img> on every scroll-driven re-render — the cover blink. Key on the cover's
	// primitive identity instead so the node is rebuilt only when it truly changes.
	const coverKey = cover
		? `${cover.kind}:${cover.value}:${
				cover.kind === CoverKind.Image && cover.focal ? `${cover.focal.x},${cover.focal.y}` : ""
			}`
		: "";
	const coverRef = useDomChild(
		() =>
			cover
				? createEntityCoverElement(
						{ id: bookmark.id },
						{ aspect: COVER_ASPECT, radius: 8, className: "bookmarks__card-swatch" },
						cover,
					)
				: null,
		[bookmark.id, coverKey],
	);
	const badgeRef = useDomChild(
		() => buildFaviconNode(bookmark, 16),
		[bookmark.id, bookmark.icon, bookmark.faviconUrl],
	);
	const bareRef = useDomChild(
		() => buildFaviconNode(bookmark, 24),
		[bookmark.id, bookmark.icon, bookmark.faviconUrl],
	);
	const hasBadge = Boolean(bookmark.icon || bookmark.faviconUrl);

	if (!cover) {
		return (
			<div className="bookmarks__card-thumb bookmarks__card-thumb--bare">
				{hasBadge ? (
					<span className="bookmarks__card-thumb-mark" aria-hidden="true" ref={bareRef} />
				) : (
					<Icon name={IconName.KindUrl} size={22} className="bookmarks__card-thumb-glyph" />
				)}
			</div>
		);
	}
	return (
		<div className="bookmarks__card-thumb">
			<span ref={coverRef} aria-hidden="true" />
			{hasBadge ? (
				<span className="bookmarks__card-favicon-badge" aria-hidden="true" ref={badgeRef} />
			) : null}
		</div>
	);
}

export function BookmarkCard({
	bookmark,
	surface,
	onOpen,
	menuContext,
	draggable,
	onCardDragStart,
	onCardDragEnd,
	dragging,
	listItemProps,
}: BookmarkCardProps) {
	const cardSurface = surfaceFor(bookmark);
	const rawSource = bookmark.siteName ?? domainFromUrl(bookmark.url);
	// A captured title that IS the domain ("example.com / example.com") makes
	// the meta row pure repetition — show the domain only when it adds
	// information (F-448, Marcus session 909).
	const source = rawSource && rawSource !== bookmark.title ? rawSource : null;
	const kind = classifyMediaType(bookmark.mediaType);
	const showSurfacePill = surface === BookmarkSurface.Tags && cardSurface !== BookmarkSurface.Inbox;

	const onCardClick = (event: ReactMouseEvent) => {
		const target = event.target as Element | null;
		if (target?.closest("button, a, .bookmarks__card-actions")) return;
		onOpen(bookmark.id);
	};

	const onContextMenu = (event: ReactMouseEvent) => {
		const ctx = menuContext();
		if (!ctx) return;
		event.preventDefault();
		void openObjectMenu({ x: event.clientX, y: event.clientY }, ctx);
	};

	const className = dragging ? "bookmarks__card bookmarks__card--dragging" : "bookmarks__card";

	return (
		// kbn-onclick-exempt: whole-card click is a mouse convenience; the title button below owns keyboard activation of the same open action.
		<li
			{...listItemProps}
			className={className}
			{...{ [ENTITY_ID_ATTR]: bookmark.id, [ENTITY_TYPE_ATTR]: BOOKMARK_ENTITY_TYPE }}
			onClick={onCardClick}
			onContextMenu={onContextMenu}
			draggable={draggable}
			{...(onCardDragStart ? { onDragStart: onCardDragStart } : {})}
			{...(onCardDragEnd ? { onDragEnd: onCardDragEnd } : {})}
		>
			<CardThumb bookmark={bookmark} />
			<div className="bookmarks__card-body">
				<div className="bookmarks__card-title-row">
					<button
						type="button"
						className="bookmarks__card-title"
						title={bookmark.url}
						aria-label={t("action.openBookmark", { title: bookmark.title || bookmark.url })}
						onClick={(event) => {
							event.stopPropagation();
							onOpen(bookmark.id);
						}}
					>
						{bookmark.title || bookmark.url}
					</button>
					{showSurfacePill ? (
						<span className={`bookmarks__surface-tag ${SURFACE_TAG_CLASS[cardSurface]}`}>
							{t(SURFACE_TAG_LABEL[cardSurface])}
						</span>
					) : null}
				</div>
				{source || hasDistinctKind(kind) ? (
					<div className="bookmarks__card-meta">
						{source ? (
							<span
								className="bookmarks__card-domain"
								title={bookmark.siteName ? bookmark.url : undefined}
							>
								{source}
							</span>
						) : null}
						{hasDistinctKind(kind) ? (
							<span className="bookmarks__card-kind" data-kind={kind}>
								{t(CONTENT_KIND_LABEL_KEY[kind] as Parameters<typeof t>[0])}
							</span>
						) : null}
					</div>
				) : null}
				{bookmark.description ? <p className="bookmarks__card-desc">{bookmark.description}</p> : null}
				{bookmark.tags.length > 0 ? (
					<div className="bookmarks__card-tags">
						{bookmark.tags.map((tag) => (
							<span key={tag} className="bookmarks__card-tag">
								#{tag}
							</span>
						))}
					</div>
				) : null}
			</div>
			<div className="bookmarks__card-actions">
				<ObjectMenuMoreButton moreActionsLabel={t("action.moreActions")} context={menuContext} />
			</div>
		</li>
	);
}
