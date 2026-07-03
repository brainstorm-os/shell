/**
 * Pure data-shaping for the Books "currently-reading" dashboard widget — no
 * React / CSS imports, so it's unit-testable in isolation (mirrors the
 * Contacts widget split). `widget.tsx` is a thin presentational shell over
 * `shapeBooksWidget`.
 */

import { bookFromEntity } from "./logic/book-open";
import { LibrarySort, sortLibrary } from "./logic/library";
import { BOOK_ENTITY_TYPE, type Book } from "./types/book";

/** Manifest widget id — must match `registrations.widgets[].id` in manifest.json. */
export const BOOKS_WIDGET_READING = "currently-reading";

/** Maximum rows the glance list shows. */
export const LIST_LIMIT = 8;

/** The typed live-read query. Books holds only the per-type
 *  `entities.read:brainstorm/Book/v1` grant (no `entities.read:*`), and the
 *  widget bridge admits scoped apps only through a typed query — an
 *  unqualified `list()` would be capability-denied. Module-level so the
 *  reference stays stable across renders. */
export const BOOKS_WIDGET_QUERY: { types: readonly string[] } = { types: [BOOK_ENTITY_TYPE] };

/** What the widget body renders: the in-progress list, the recently-added
 *  fallback (no book is partway through), or the shared empty state. */
export enum BooksWidgetMode {
	Reading = "reading",
	RecentlyAdded = "recently-added",
	Empty = "empty",
}

/** Per-row reading status — drives bar vs. dim caption. */
export enum BookRowStatus {
	InProgress = "in-progress",
	NotStarted = "not-started",
	Finished = "finished",
}

export type WidgetBook = {
	id: string;
	title: string;
	author: string;
	/** 0..1 fraction for the bar fill width. */
	progress: number;
	/** Whole-percent caption value (rounded). */
	percent: number;
	status: BookRowStatus;
};

/** The minimal vault-entity shape the widget reads (a subset of the live
 *  snapshot's rows) — kept local so the shaper is testable without the full
 *  `react-yjs` entity type. */
export type WidgetBookEntity = {
	id: string;
	type: string;
	properties: Record<string, unknown>;
	deletedAt: number | null;
};

function rowStatus(book: Book): BookRowStatus {
	if (book.reading.progress >= 1) return BookRowStatus.Finished;
	if (book.reading.progress > 0) return BookRowStatus.InProgress;
	return BookRowStatus.NotStarted;
}

function toRow(book: Book): WidgetBook {
	return {
		id: book.id,
		title: book.name,
		author: book.author,
		progress: book.reading.progress,
		percent: Math.round(book.reading.progress * 100),
		status: rowStatus(book),
	};
}

/** Newest catalog entries first — the fallback shelf when nothing is
 *  partway through. Title tie-break keeps the order stable. */
function byRecentlyAdded(a: Book, b: Book): number {
	return (
		b.createdAt - a.createdAt || a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
	);
}

/**
 * Filter the live snapshot to non-deleted `Book/v1` rows (undecodable rows
 * are dropped, never blank the tile), then pick the widget mode: books with
 * `0 < progress < 1` render as the reading list ordered by `lastReadAt`
 * desc (never-read last, via the library's Recent sort); with none in
 * progress but books present, the most recently added books show instead;
 * with no books at all the empty state invites an import. `inProgressCount`
 * is the full in-progress total, independent of the row cap.
 */
export function shapeBooksWidget(
	entities: readonly WidgetBookEntity[],
	limit = LIST_LIMIT,
): { mode: BooksWidgetMode; books: WidgetBook[]; inProgressCount: number } {
	const books: Book[] = [];
	for (const entity of entities) {
		if (entity.type !== BOOK_ENTITY_TYPE || entity.deletedAt !== null) continue;
		const book = bookFromEntity(entity);
		if (book) books.push(book);
	}
	const inProgress = books.filter((b) => b.reading.progress > 0 && b.reading.progress < 1);
	if (inProgress.length > 0) {
		return {
			mode: BooksWidgetMode.Reading,
			books: sortLibrary(inProgress, LibrarySort.Recent).slice(0, limit).map(toRow),
			inProgressCount: inProgress.length,
		};
	}
	if (books.length > 0) {
		return {
			mode: BooksWidgetMode.RecentlyAdded,
			books: [...books].sort(byRecentlyAdded).slice(0, limit).map(toRow),
			inProgressCount: 0,
		};
	}
	return { mode: BooksWidgetMode.Empty, books: [], inProgressCount: 0 };
}
