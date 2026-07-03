/**
 * Books "currently-reading" widget — pure data-shaping coverage. The
 * `shapeBooksWidget` projection is the widget's only non-presentational
 * logic; the component shell mirrors the real-shell-verified Contacts widget.
 */

import { describe, expect, it } from "vitest";
import { BOOK_ENTITY_TYPE } from "./types/book";
import {
	BookRowStatus,
	BooksWidgetMode,
	type WidgetBookEntity,
	shapeBooksWidget,
} from "./widget-data";

function bookEntity(
	id: string,
	over: {
		name?: string;
		author?: string;
		progress?: number;
		lastReadAt?: number | null;
		createdAt?: number;
	} = {},
	deletedAt: number | null = null,
): WidgetBookEntity {
	const progress = over.progress ?? 0;
	return {
		id,
		type: BOOK_ENTITY_TYPE,
		deletedAt,
		properties: {
			id,
			name: over.name ?? `Book ${id}`,
			format: "pdf",
			author: over.author ?? "",
			fileId: null,
			spineLength: 10,
			reading: {
				position: progress > 0 ? "bkcfi:/1:100" : null,
				progress,
				lastReadAt: over.lastReadAt ?? null,
			},
			createdAt: over.createdAt ?? 0,
			updatedAt: over.createdAt ?? 0,
		},
	};
}

describe("shapeBooksWidget", () => {
	it("keeps only non-deleted Book/v1 rows and drops undecodable ones", () => {
		const entities: WidgetBookEntity[] = [
			bookEntity("b1", { progress: 0.5 }),
			{ ...bookEntity("n1", { progress: 0.5 }), type: "brainstorm/Note/v1" },
			bookEntity("b2", { progress: 0.5 }, 123),
			bookEntity("", { progress: 0.5 }),
		];
		const { mode, books, inProgressCount } = shapeBooksWidget(entities);
		expect(mode).toBe(BooksWidgetMode.Reading);
		expect(inProgressCount).toBe(1);
		expect(books.map((b) => b.id)).toEqual(["b1"]);
	});

	it("lists only in-progress books (0 < progress < 1) in reading mode", () => {
		const entities = [
			bookEntity("unstarted", { progress: 0 }),
			bookEntity("halfway", { progress: 0.5, lastReadAt: 100 }),
			bookEntity("finished", { progress: 1, lastReadAt: 200 }),
		];
		const { mode, books, inProgressCount } = shapeBooksWidget(entities);
		expect(mode).toBe(BooksWidgetMode.Reading);
		expect(inProgressCount).toBe(1);
		expect(books.map((b) => b.id)).toEqual(["halfway"]);
		expect(books[0]?.status).toBe(BookRowStatus.InProgress);
	});

	it("orders the reading list by lastReadAt desc with never-read last", () => {
		const entities = [
			bookEntity("never", { progress: 0.2, lastReadAt: null }),
			bookEntity("old", { progress: 0.4, lastReadAt: 100 }),
			bookEntity("new", { progress: 0.6, lastReadAt: 300 }),
		];
		const { books } = shapeBooksWidget(entities);
		expect(books.map((b) => b.id)).toEqual(["new", "old", "never"]);
	});

	it("rounds the percent caption from the raw fraction", () => {
		const { books } = shapeBooksWidget([bookEntity("b", { progress: 0.416, lastReadAt: 1 })]);
		expect(books[0]?.percent).toBe(42);
		expect(books[0]?.progress).toBeCloseTo(0.416);
	});

	it("caps the projection at the limit but reports the full in-progress total", () => {
		const entities = Array.from({ length: 12 }, (_, i) =>
			bookEntity(`b${i}`, { progress: 0.5, lastReadAt: i }),
		);
		const { books, inProgressCount } = shapeBooksWidget(entities, 8);
		expect(inProgressCount).toBe(12);
		expect(books).toHaveLength(8);
		expect(books[0]?.id).toBe("b11");
	});

	it("falls back to recently-added when no book is in progress", () => {
		const entities = [
			bookEntity("older", { progress: 0, createdAt: 100 }),
			bookEntity("newest", { progress: 1, lastReadAt: 50, createdAt: 300 }),
			bookEntity("mid", { progress: 0, createdAt: 200 }),
		];
		const { mode, books, inProgressCount } = shapeBooksWidget(entities);
		expect(mode).toBe(BooksWidgetMode.RecentlyAdded);
		expect(inProgressCount).toBe(0);
		expect(books.map((b) => b.id)).toEqual(["newest", "mid", "older"]);
		expect(books[0]?.status).toBe(BookRowStatus.Finished);
		expect(books[1]?.status).toBe(BookRowStatus.NotStarted);
	});

	it("returns the empty mode when the vault has no books", () => {
		const { mode, books, inProgressCount } = shapeBooksWidget([]);
		expect(mode).toBe(BooksWidgetMode.Empty);
		expect(books).toEqual([]);
		expect(inProgressCount).toBe(0);
	});

	it("projects title and author into the row", () => {
		const { books } = shapeBooksWidget([
			bookEntity("b", { name: "Dune", author: "Frank Herbert", progress: 0.5 }),
		]);
		expect(books[0]).toMatchObject({ title: "Dune", author: "Frank Herbert" });
	});
});
