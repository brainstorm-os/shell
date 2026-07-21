/**
 * `Book/v1` codec — the pure mapping between the `Book` struct and the flat
 * entity property record the entities service stores. This is the keystone
 * for the 9.21.6 library + reading-position persistence: the renderer holds
 * a `Book`, the vault holds a `BookRecord`, and these functions are the
 * only crossing.
 *
 * The reading position is persisted as the CFI-style locator wire form
 * (`bkcfi:/<spine>:<char>`, see types/locator.ts), NOT a `{spineIndex,
 * charOffset}` blob — one canonical string the real epub.js parser (9.21.2)
 * can map true CFIs onto without a schema change. `progress` + `lastReadAt`
 * are denormalized alongside it so the library can sort/render without
 * re-paginating every book.
 *
 * App-local + pure: the entity reads/writes themselves flow through
 * @brainstorm-os/react-yjs when the real library list lands (gated on 9.21.2);
 * this module owns only the shape, so it is buildable + testable now.
 */

import { type Book, BookFormat, type ReadingState, emptyReadingState } from "../types/book";
import { type Icon, IconKind } from "../types/icon";
import { type Locator, parseLocator, serializeLocator } from "../types/locator";

/** The flat property record the entities service stores for a `Book/v1`.
 *  Mirrors the manifest schema; `reading.position` is the serialized
 *  locator string (or `null` when never opened). */
export type BookRecord = {
	id: string;
	name: string;
	icon: Icon | null;
	format: string;
	author: string;
	fileId: string | null;
	spineLength: number;
	reading: {
		position: string | null;
		progress: number;
		lastReadAt: number | null;
	};
	createdAt: number;
	updatedAt: number;
};

function parseFormat(raw: unknown): BookFormat {
	return raw === BookFormat.Pdf ? BookFormat.Pdf : BookFormat.Epub;
}

function clampProgress(raw: unknown): number {
	if (typeof raw !== "number" || Number.isNaN(raw)) return 0;
	return Math.min(1, Math.max(0, raw));
}

function parseIcon(raw: unknown): Icon | null {
	if (!raw || typeof raw !== "object") return null;
	const icon = raw as { kind?: unknown; value?: unknown; color?: unknown };
	if (typeof icon.value !== "string") return null;
	switch (icon.kind) {
		case IconKind.Pack:
			return typeof icon.color === "string"
				? { kind: IconKind.Pack, value: icon.value, color: icon.color }
				: { kind: IconKind.Pack, value: icon.value };
		case IconKind.Emoji:
			return { kind: IconKind.Emoji, value: icon.value };
		case IconKind.Image:
			return { kind: IconKind.Image, value: icon.value };
		default:
			return null;
	}
}

function parseReadingState(raw: unknown): ReadingState {
	if (!raw || typeof raw !== "object") return emptyReadingState();
	const reading = raw as { position?: unknown; progress?: unknown; lastReadAt?: unknown };
	const position = typeof reading.position === "string" ? parseLocator(reading.position) : null;
	const lastReadAt = typeof reading.lastReadAt === "number" ? reading.lastReadAt : null;
	return { position, progress: clampProgress(reading.progress), lastReadAt };
}

/** Serialize a `Book` to its stored entity record. */
export function serializeBook(book: Book): BookRecord {
	return {
		id: book.id,
		name: book.name,
		icon: book.icon,
		format: book.format,
		author: book.author,
		fileId: book.fileId,
		spineLength: book.spineLength,
		reading: {
			position: book.reading.position ? serializeLocator(book.reading.position) : null,
			progress: clampProgress(book.reading.progress),
			lastReadAt: book.reading.lastReadAt,
		},
		createdAt: book.createdAt,
		updatedAt: book.updatedAt,
	};
}

/** Parse a stored entity record back into a `Book`. Defensive against
 *  partial / legacy records — a missing field falls back rather than
 *  throwing, so a hand-edited or older vault row still opens. */
export function parseBook(record: Partial<BookRecord>): Book | null {
	if (typeof record.id !== "string" || record.id.length === 0) return null;
	const now = typeof record.createdAt === "number" ? record.createdAt : 0;
	return {
		id: record.id,
		name: typeof record.name === "string" ? record.name : "",
		icon: parseIcon(record.icon),
		format: parseFormat(record.format),
		author: typeof record.author === "string" ? record.author : "",
		fileId: typeof record.fileId === "string" ? record.fileId : null,
		spineLength: typeof record.spineLength === "number" ? record.spineLength : 0,
		reading: parseReadingState(record.reading),
		createdAt: now,
		updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : now,
	};
}

/** Produce a `Book` with its reading position parked at `locator` (a
 *  measured `progress`, 0..1), stamping `lastReadAt` + `updatedAt`. The
 *  pure core of per-book reading-position persistence: the reader calls
 *  this on navigation, the result is serialized + written to the vault. */
export function withReadingPosition(
	book: Book,
	locator: Locator,
	progress: number,
	now: number,
): Book {
	return {
		...book,
		reading: {
			position: locator,
			progress: clampProgress(progress),
			lastReadAt: now,
		},
		updatedAt: now,
	};
}
