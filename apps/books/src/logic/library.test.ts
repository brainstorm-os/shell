import { describe, expect, it } from "vitest";
import { type Book, BookFormat } from "../types/book";
import { type Locator, makeLocator } from "../types/locator";
import {
	type LibrarySectionLabels,
	LibrarySort,
	booksFromEntities,
	buildLibrarySections,
	buildLibraryView,
	continueReading,
	filterLibrary,
	isInProgress,
	sortLibrary,
	withLiveProgress,
} from "./library";

const SECTION_LABELS: LibrarySectionLabels = {
	today: "Today",
	yesterday: "Yesterday",
	last7: "Previous 7 days",
	last30: "Previous 30 days",
	notStarted: "Not started",
};

function aBook(
	id: string,
	name: string,
	reading: { position: Locator | null; progress: number; lastReadAt: number | null },
	author = "Anon",
): Book {
	return {
		id,
		name,
		icon: null,
		format: BookFormat.Epub,
		author,
		fileId: null,
		spineLength: 1,
		reading,
		createdAt: 0,
		updatedAt: 0,
	};
}

const unread = (id: string, name: string, author?: string): Book =>
	aBook(id, name, { position: null, progress: 0, lastReadAt: null }, author);

const reading = (id: string, name: string, progress: number, lastReadAt: number): Book =>
	aBook(id, name, { position: makeLocator(0, 1), progress, lastReadAt });

describe("library sort", () => {
	it("recent: most-recently-read first, never-read sink to the bottom", () => {
		const a = reading("a", "Alpha", 0.2, 100);
		const b = reading("b", "Beta", 0.5, 300);
		const c = unread("c", "Gamma");
		expect(sortLibrary([a, c, b], LibrarySort.Recent).map((x) => x.id)).toEqual(["b", "a", "c"]);
	});

	it("recent: ties (both never read) break by title", () => {
		const z = unread("z", "Zebra");
		const a = unread("a", "Apple");
		expect(sortLibrary([z, a], LibrarySort.Recent).map((x) => x.id)).toEqual(["a", "z"]);
	});

	it("title: A→Z, case-insensitive", () => {
		const books = [unread("1", "banana"), unread("2", "Apple"), unread("3", "cherry")];
		expect(sortLibrary(books, LibrarySort.Title).map((x) => x.name)).toEqual([
			"Apple",
			"banana",
			"cherry",
		]);
	});

	it("progress: furthest-along first", () => {
		const a = reading("a", "Alpha", 0.1, 1);
		const b = reading("b", "Beta", 0.9, 1);
		const c = reading("c", "Gamma", 0.5, 1);
		expect(sortLibrary([a, b, c], LibrarySort.Progress).map((x) => x.id)).toEqual(["b", "c", "a"]);
	});

	it("does not mutate the input array", () => {
		const books = [unread("z", "Z"), unread("a", "A")];
		const snapshot = [...books];
		sortLibrary(books, LibrarySort.Title);
		expect(books).toEqual(snapshot);
	});
});

describe("library filter", () => {
	const books = [
		unread("1", "On the Shape of Vaults", "A. Reader"),
		unread("2", "Deep Work", "Cal Newport"),
	];

	it("matches title substring case-insensitively", () => {
		expect(filterLibrary(books, "shape").map((b) => b.id)).toEqual(["1"]);
	});

	it("matches author substring", () => {
		expect(filterLibrary(books, "newport").map((b) => b.id)).toEqual(["2"]);
	});

	it("returns everything for a blank query", () => {
		expect(filterLibrary(books, "   ")).toHaveLength(2);
	});

	it("returns empty for no match", () => {
		expect(filterLibrary(books, "zzz")).toHaveLength(0);
	});
});

describe("buildLibraryView", () => {
	it("filters then sorts", () => {
		const books = [
			reading("a", "Atlas", 0.1, 100),
			reading("b", "Atmosphere", 0.5, 50),
			unread("c", "Other"),
		];
		expect(buildLibraryView(books, LibrarySort.Recent, "At").map((x) => x.id)).toEqual(["a", "b"]);
	});
});

describe("buildLibrarySections", () => {
	// 2026-06-13 (the session date) as the fixed "now" for deterministic buckets.
	const now = Date.UTC(2026, 5, 13, 12, 0, 0);
	const DAY = 86_400_000;

	it("groups read books into recency buckets, never-read into 'Not started' last", () => {
		const books = [
			reading("today", "Today Book", 0.2, now - 1000),
			reading("week", "Week Book", 0.4, now - 3 * DAY),
			unread("new1", "Zeta"),
			unread("new2", "Alpha"),
		];
		const sections = buildLibrarySections(books, "", SECTION_LABELS, now);
		expect(sections.map((s) => s.label)).toEqual(["Today", "Previous 7 days", "Not started"]);
		// Read buckets keep recency order; the unread group is title-sorted.
		expect(sections[0]?.books.map((b) => b.id)).toEqual(["today"]);
		expect(sections[2]?.books.map((b) => b.id)).toEqual(["new2", "new1"]);
	});

	it("applies the search filter before grouping", () => {
		const books = [reading("a", "Atlas", 0.1, now - 1000), unread("b", "Other")];
		const sections = buildLibrarySections(books, "atlas", SECTION_LABELS, now);
		expect(sections).toHaveLength(1);
		expect(sections[0]?.books.map((b) => b.id)).toEqual(["a"]);
	});

	it("returns no sections when nothing matches", () => {
		expect(buildLibrarySections([unread("a", "A")], "zzz", SECTION_LABELS, now)).toHaveLength(0);
	});
});

describe("in-progress shelf", () => {
	it("isInProgress is true only for a parked, partly-read book", () => {
		expect(isInProgress(reading("a", "A", 0.5, 1))).toBe(true);
		expect(isInProgress(unread("b", "B"))).toBe(false);
		expect(isInProgress(reading("c", "C", 1, 1))).toBe(false);
		expect(isInProgress(reading("d", "D", 0, 1))).toBe(false);
	});

	it("continueReading lists partly-read books, most-recent first", () => {
		const a = reading("a", "A", 0.3, 100);
		const b = reading("b", "B", 0.6, 300);
		const done = reading("c", "C", 1, 400);
		const fresh = unread("d", "D");
		expect(continueReading([a, b, done, fresh]).map((x) => x.id)).toEqual(["b", "a"]);
	});
});

describe("booksFromEntities", () => {
	it("decodes Book/v1 rows and ignores other types + unparsable rows", () => {
		const books = booksFromEntities([
			{
				id: "b1",
				type: "brainstorm/Book/v1",
				properties: { name: "Deep Work", format: "pdf", author: "Cal Newport" },
			},
			{ id: "n1", type: "brainstorm/Note/v1", properties: { name: "not a book" } },
			// Unparsable Book row: the codec needs the id we inject, so a row is
			// only droppable via a blank id.
			{ id: "", type: "brainstorm/Book/v1", properties: {} },
		]);
		expect(books.map((b) => b.id)).toEqual(["b1"]);
		expect(books[0]?.name).toBe("Deep Work");
		expect(books[0]?.format).toBe(BookFormat.Pdf);
	});
});

// The footer measures progress against the LIVE pagination; the stored
// fraction was measured against whatever viewport last turned a page. Shown
// side by side they disagreed ("45%" in the row, "23% read" in the footer).
describe("withLiveProgress", () => {
	const shelf = [reading("a", "A", 0.45, 10), reading("b", "B", 0.8, 20)];

	it("shows the open book at the reader's live progress", () => {
		const out = withLiveProgress(shelf, { bookId: "a", progress: 0.23 });
		expect(out.map((b) => b.reading.progress)).toEqual([0.23, 0.8]);
		expect(out[0]?.reading.lastReadAt).toBe(10);
	});

	it("returns the same list when nothing is live or nothing differs", () => {
		expect(withLiveProgress(shelf, null)).toBe(shelf);
		expect(withLiveProgress(shelf, { bookId: "a", progress: 0.45 })).toBe(shelf);
		expect(withLiveProgress(shelf, { bookId: "zzz", progress: 0.1 })).toBe(shelf);
	});
});
