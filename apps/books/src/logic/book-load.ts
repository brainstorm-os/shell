/**
 * Bytes → a readable book. The reader routes on what the file IS (sniffed
 * from its bytes), not on what its name or its catalog record claims, so a
 * mislabelled import still opens — and a file that cannot open fails with a
 * reason the UI can state, rather than a blank page.
 *
 * Pure orchestration: the EPUB parser is injected, so every branch is
 * unit-tested without epub.js.
 */

import { BookFormat } from "../types/book";
import { SniffedKind, sniffBookBytes } from "./book-sniff";
import { type BookContent, indexSpine, totalLength } from "./content";
import { type Fb2Cover, parseFb2 } from "./fb2-parser";
import { listZipEntries, readZipEntry } from "./zip-reader";

/** Why a book did not open — one user-facing message each. */
export enum BookOpenFailure {
	/** The catalog record or its file is gone, or the bytes would not load. */
	Missing = "missing",
	/** The file is a format Books does not read. */
	Unsupported = "unsupported",
	/** The file is a book format, but damaged or not what it claims. */
	Damaged = "damaged",
	/** The file parsed, and holds no readable text. */
	Empty = "empty",
	TimedOut = "timed-out",
}

export class BookOpenError extends Error {
	readonly failure: BookOpenFailure;
	constructor(failure: BookOpenFailure, message: string) {
		super(message);
		this.name = "BookOpenError";
		this.failure = failure;
	}
}

/** The failure to report for anything thrown on the open path. */
export function failureOf(error: unknown): BookOpenFailure {
	return error instanceof BookOpenError ? error.failure : BookOpenFailure.Missing;
}

/** The catalog format a sniffed file reads as, or `null` when Books has no
 *  reader for it. A zipped FB2 is still an FB2 book. */
export function formatOfSniff(kind: SniffedKind): BookFormat | null {
	switch (kind) {
		case SniffedKind.Pdf:
			return BookFormat.Pdf;
		case SniffedKind.Epub:
			return BookFormat.Epub;
		case SniffedKind.Fb2:
		case SniffedKind.Fb2Zip:
			return BookFormat.Fb2;
		default:
			return null;
	}
}

export type ReflowBook = {
	format: BookFormat.Epub | BookFormat.Fb2;
	content: BookContent;
	/** An embedded cover image, when the format carries one Books extracts. */
	cover: Fb2Cover | null;
};

export type ReflowParsers = {
	parseEpub: (bytes: Uint8Array) => Promise<BookContent>;
};

async function unzipFb2(bytes: Uint8Array): Promise<Uint8Array> {
	const entry = listZipEntries(bytes).find((e) => e.name.toLowerCase().endsWith(".fb2"));
	if (!entry) throw new BookOpenError(BookOpenFailure.Damaged, "no .fb2 entry in the archive");
	return readZipEntry(bytes, entry);
}

function hasText(content: BookContent): boolean {
	return totalLength(indexSpine(content)) > 0;
}

/** Parse a reflowable book (EPUB / FB2 / zipped FB2) of the given sniffed
 *  kind. Throws a `BookOpenError` for every way that can fail. */
export async function loadReflowBook(
	bytes: Uint8Array,
	kind: SniffedKind,
	parsers: ReflowParsers,
): Promise<ReflowBook> {
	let book: ReflowBook;
	try {
		if (kind === SniffedKind.Epub) {
			book = { format: BookFormat.Epub, content: await parsers.parseEpub(bytes), cover: null };
		} else if (kind === SniffedKind.Fb2 || kind === SniffedKind.Fb2Zip) {
			const fb2 = parseFb2(kind === SniffedKind.Fb2Zip ? await unzipFb2(bytes) : bytes);
			book = { format: BookFormat.Fb2, content: fb2.content, cover: fb2.cover };
		} else {
			throw new BookOpenError(BookOpenFailure.Unsupported, `no reader for a ${kind} file`);
		}
	} catch (error) {
		if (error instanceof BookOpenError) throw error;
		throw new BookOpenError(BookOpenFailure.Damaged, (error as Error).message);
	}
	if (!hasText(book.content)) {
		throw new BookOpenError(BookOpenFailure.Empty, "the book has no readable text");
	}
	return book;
}
