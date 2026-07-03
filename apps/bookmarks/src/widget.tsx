/**
 * Bookmarks dashboard widget (Stage 7.3). When Bookmarks is launched as a
 * dashboard widget (`launch.reason === "widget"`), `app.ts`'s bootstrap mounts
 * this React surface instead of the full imperative app — the same bundle, in
 * widget-mode. The one registered widget, `recent-bookmarks`, is a glance list
 * of saved links (title + dim host) with an in-widget sort control; the shell
 * strip above draws the title / open / collapse / ⋯ chrome, and clicking a row
 * opens that bookmark in the Bookmarks app via the shell intent bus.
 */

import { openEntity } from "@brainstorm/sdk";
import { AppErrorBoundary } from "@brainstorm/sdk/error-boundary";
import { SelectMenu } from "@brainstorm/sdk/select-menu";
import "@brainstorm/sdk/select-menu.css";
import { useVaultEntities } from "@brainstorm/react-yjs";
import type { VaultEntitiesService } from "@brainstorm/sdk-types";
import { mountMenuHost } from "@brainstorm/sdk/menus";
import {
	WidgetEmpty,
	type WidgetLaunch,
	WidgetRoot,
	useWidgetVisible,
} from "@brainstorm/sdk/widget";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { plural, t } from "./i18n/manifest";
import { domainFromUrl } from "./logic/url-parse";
import { getBrainstorm } from "./storage/runtime";
import { BOOKMARK_ENTITY_TYPE } from "./types/bookmark";
import "./widget.css";

/** Manifest widget id — must match `registrations.widgets[].id` in manifest.json. */
export const BOOKMARKS_WIDGET_RECENT = "recent-bookmarks";

const RECENT_LIMIT = 8;

/** Server-side narrowing for the widget's entity subscription (F-384) —
 *  module-level so the reference is stable across renders. */
const WIDGET_QUERY = { types: [BOOKMARK_ENTITY_TYPE] } as const;

/** Empty-state CTA (F-381): an entityType-only `open` routes to the type's
 *  registered opener and launches the full Bookmarks app. */
function openBookmarksApp(): void {
	const dispatch = getBrainstorm()?.services?.intents?.dispatch;
	if (!dispatch) return;
	void dispatch({ verb: "open", payload: { entityType: BOOKMARK_ENTITY_TYPE } });
}

/** How the glance list is ordered — the in-widget sort control's value set. */
enum BookmarksSort {
	Recent = "recent",
	Title = "title",
}

type RecentBookmark = { id: string; title: string; host: string | null };

function bookmarkTitle(properties: Record<string, unknown>): string {
	const title = properties.title;
	if (typeof title === "string" && title.trim().length > 0) return title;
	const url = properties.url;
	if (typeof url === "string") {
		const host = domainFromUrl(url);
		if (host) return host;
	}
	return t("widget.untitled");
}

function bookmarkHost(properties: Record<string, unknown>): string | null {
	const url = properties.url;
	return typeof url === "string" ? domainFromUrl(url) : null;
}

function openBookmark(id: string): void {
	const runtime = getBrainstorm();
	const dispatch = runtime?.services?.intents?.dispatch;
	if (!dispatch) return;
	void openEntity(
		{ services: { intents: { dispatch } } },
		{
			entityId: id,
			entityType: BOOKMARK_ENTITY_TYPE,
		},
	);
}

function RecentBookmarks({
	bookmarks,
	total,
	sort,
	onSort,
}: {
	bookmarks: RecentBookmark[];
	total: number;
	sort: BookmarksSort;
	onSort: (next: BookmarksSort) => void;
}) {
	return (
		<div className="bookmarks-widget">
			<div className="bookmarks-widget__toolbar">
				<SelectMenu<BookmarksSort>
					value={sort}
					onChange={onSort}
					ariaLabel={t("widget.sort.label")}
					options={[
						{ value: BookmarksSort.Recent, label: t("widget.sort.recent") },
						{ value: BookmarksSort.Title, label: t("widget.sort.title") },
					]}
				/>
				<span className="bookmarks-widget__count">
					{plural(total, "widget.count.one", "widget.count.many", { count: total })}
				</span>
			</div>
			{bookmarks.length === 0 ? (
				<WidgetEmpty
					message={t("widget.empty")}
					actionLabel={t("widget.emptyAction")}
					onAction={openBookmarksApp}
				/>
			) : (
				<ul className="bookmarks-widget__list">
					{bookmarks.map((bookmark) => (
						<li key={bookmark.id}>
							<button
								type="button"
								className="bookmarks-widget__row"
								onClick={() => openBookmark(bookmark.id)}
							>
								<span className="bookmarks-widget__title">{bookmark.title}</span>
								{bookmark.host ? <span className="bookmarks-widget__host">{bookmark.host}</span> : null}
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function sortBookmarks(
	bookmarks: readonly RecentBookmark[],
	sort: BookmarksSort,
): RecentBookmark[] {
	// `bookmarks` is already ordered newest-first; only Title needs a re-sort.
	if (sort !== BookmarksSort.Title) return [...bookmarks];
	return [...bookmarks].sort((a, b) => a.title.localeCompare(b.title));
}

export function BookmarksWidget({ launch }: { launch: WidgetLaunch }) {
	const runtime = getBrainstorm();
	// Reactive over the shell's live vault-entity index — pauses implicitly when
	// the host scrolls the widget off-screen (the surface stops re-rendering).
	useWidgetVisible();
	const [sort, setSort] = useState<BookmarksSort>(BookmarksSort.Recent);
	// The app's narrowed runtime type exposes only `onChange`; the live shell
	// service carries the full `list()` surface `useVaultEntities` reads.
	const vaultEntities =
		(runtime?.services?.vaultEntities as VaultEntitiesService | undefined) ?? null;
	const { entities } = useVaultEntities(vaultEntities, { query: WIDGET_QUERY });

	const live = useMemo(
		() => entities.filter((e) => e.type === BOOKMARK_ENTITY_TYPE && e.deletedAt === null),
		[entities],
	);
	const total = live.length;

	const bookmarks = useMemo<RecentBookmark[]>(() => {
		const ordered = [...live].sort((a, b) => b.updatedAt - a.updatedAt);
		const top = ordered.slice(0, RECENT_LIMIT).map((e) => ({
			id: e.id,
			title: bookmarkTitle(e.properties),
			host: bookmarkHost(e.properties),
		}));
		return sortBookmarks(top, sort);
	}, [live, sort]);

	return (
		<WidgetRoot
			widgets={[
				{
					id: BOOKMARKS_WIDGET_RECENT,
					render: () => (
						<RecentBookmarks bookmarks={bookmarks} total={total} sort={sort} onSort={setSort} />
					),
				},
			]}
			launch={launch}
		/>
	);
}

/** Stand up the menu host + mount the widget surface into `root`, wrapped in the
 *  shared error boundary. Called from `app.ts`'s widget-mode branch — the JSX
 *  lives here (a `.tsx`) so the imperative `app.ts` stays free of `createElement`
 *  children plumbing. */
export function mountBookmarksWidget(root: HTMLElement, launch: WidgetLaunch): void {
	mountMenuHost();
	createRoot(root).render(
		<AppErrorBoundary appName="bookmarks">
			<BookmarksWidget launch={launch} />
		</AppErrorBoundary>,
	);
}
