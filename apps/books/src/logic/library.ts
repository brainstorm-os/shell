/**
 * The pure library model for the 9.21.6 in-vault shelf: ordering + filtering
 * over the live `Book/v1` list, and the persistence seam the reader uses to
 * park a reading position.
 *
 * App-local + pure. The *list itself* is a vault-entity list, so when the
 * real reads land (gated on 9.21.2) it flows through `useVaultEntities` /
 * `@brainstorm-os/react-yjs` per the reactivity rule — NOT a hand-rolled
 * onChange→list→render loop. This module owns only the ordering math + the
 * write seam, both of which are reactivity-agnostic and testable today.
 */

import { type DateBucketLabels, groupByDateBucket } from "@brainstorm-os/sdk/date-buckets";
import { BOOK_ENTITY_TYPE, type Book } from "../types/book";
import { bookFromEntity } from "./book-open";

/** The slice of a live vault-snapshot row the shelf reads. */
export type LibraryEntity = {
	id: string;
	type: string;
	properties: Record<string, unknown>;
};

/** Decode the `Book/v1` rows out of a live vault snapshot. Rows that fail
 *  to parse are dropped (a hand-edited record must not blank the shelf). */
export function booksFromEntities(entities: readonly LibraryEntity[]): Book[] {
	const books: Book[] = [];
	for (const entity of entities) {
		if (entity.type !== BOOK_ENTITY_TYPE) continue;
		const book = bookFromEntity(entity);
		if (book) books.push(book);
	}
	return books;
}

/** How the shelf is ordered. Wire/UI value is the string (enum, not a raw
 *  literal, per conventions). */
export enum LibrarySort {
	/** Most recently read first; never-opened books sink to the bottom. */
	Recent = "recent",
	/** A→Z by title. */
	Title = "title",
	/** Furthest-along first — the "almost finished" shelf. */
	Progress = "progress",
}

function compareByTitle(a: Book, b: Book): number {
	return (
		a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id)
	);
}

/** Recent: by `lastReadAt` desc; a never-read book (`null`) ranks after any
 *  read one, then ties break by title for a stable shelf. */
function compareByRecent(a: Book, b: Book): number {
	const ra = a.reading.lastReadAt;
	const rb = b.reading.lastReadAt;
	if (ra !== rb) {
		if (ra === null) return 1;
		if (rb === null) return -1;
		return rb - ra;
	}
	return compareByTitle(a, b);
}

function compareByProgress(a: Book, b: Book): number {
	if (a.reading.progress !== b.reading.progress) return b.reading.progress - a.reading.progress;
	return compareByTitle(a, b);
}

const COMPARATORS: Record<LibrarySort, (a: Book, b: Book) => number> = {
	[LibrarySort.Recent]: compareByRecent,
	[LibrarySort.Title]: compareByTitle,
	[LibrarySort.Progress]: compareByProgress,
};

/** Order a list of books by the chosen sort. Pure — returns a new array. */
export function sortLibrary(books: readonly Book[], sort: LibrarySort): Book[] {
	return [...books].sort(COMPARATORS[sort]);
}

/** Case-insensitive substring match over title + author — the shelf search
 *  box. A blank query returns every book. */
export function filterLibrary(books: readonly Book[], query: string): Book[] {
	const needle = query.trim().toLowerCase();
	if (needle.length === 0) return [...books];
	return books.filter(
		(book) => book.name.toLowerCase().includes(needle) || book.author.toLowerCase().includes(needle),
	);
}

/** Filter then sort — the shelf's full ordering pipeline. */
export function buildLibraryView(books: readonly Book[], sort: LibrarySort, query = ""): Book[] {
	return sortLibrary(filterLibrary(books, query), sort);
}

/** One titled section of the shelf (Notes-style recency grouping). */
export type LibrarySection = { key: string; label: string; books: Book[] };

/** Section captions: the four shared date-bucket labels + a trailing
 *  "not started" group for never-opened books. */
export type LibrarySectionLabels = DateBucketLabels & { notStarted: string };

/**
 * Group the (query-filtered) shelf into recency sections, mirroring the Notes
 * sidebar: books you've opened fall under date buckets (Today / Yesterday /
 * Previous 7 days / … / by month), most-recent first; never-opened books
 * collect in a trailing "Not started" section ordered by title. `now` is
 * injected so the bucketing stays pure/testable.
 */
export function buildLibrarySections(
	books: readonly Book[],
	query: string,
	labels: LibrarySectionLabels,
	now: number,
): LibrarySection[] {
	const filtered = filterLibrary(books, query);
	const read = sortLibrary(
		filtered.filter((b) => b.reading.lastReadAt !== null),
		LibrarySort.Recent,
	);
	const sections: LibrarySection[] = groupByDateBucket(read, (b) => b.reading.lastReadAt ?? 0, {
		now,
		labels,
	}).map((group) => ({ key: group.bucket.key, label: group.bucket.label, books: group.items }));
	const unread = sortLibrary(
		filtered.filter((b) => b.reading.lastReadAt === null),
		LibrarySort.Title,
	);
	if (unread.length > 0) {
		sections.push({ key: "not-started", label: labels.notStarted, books: unread });
	}
	return sections;
}

/** True once the book has been opened far enough to count as "in progress"
 *  (any position parked, not at the very start). Drives the shelf's
 *  Continue-reading affordance. */
export function isInProgress(book: Book): boolean {
	return book.reading.position !== null && book.reading.progress > 0 && book.reading.progress < 1;
}

/** The books the reader is partway through, most-recent first — the
 *  "Continue reading" shelf row. */
export function continueReading(books: readonly Book[]): Book[] {
	return sortLibrary(books.filter(isInProgress), LibrarySort.Recent);
}

/** The persistence seam for per-book reading state. The reader calls
 *  `saveReadingPosition` whenever the parked locator changes; the preview
 *  drop leaves it unset (in-memory only), and 9.21.2 wires it to a
 *  `Book/v1` property write through the entities service. Mirrors the
 *  `HighlightPort` seam pattern. */
export type BookLibraryPort = {
	/** Persist a book whose reading state changed (the full updated `Book`,
	 *  already advanced via `withReadingPosition`). */
	saveReadingPosition?: (book: Book) => void;
};
