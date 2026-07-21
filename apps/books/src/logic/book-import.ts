/**
 * Import-a-book (9.21.2 import slice) — the pure core of bringing an
 * external EPUB / PDF
 * into the vault. The renderer picks a file through the Files host service,
 * seals its bytes into the encrypted asset store (`files.import`), then
 * writes two entities: a `brainstorm/File/v1` for the binary and a
 * `brainstorm/Book/v1` catalog record pointing at it via `fileId`.
 *
 * These helpers own the record shapes + the filename → title / format
 * derivation so every branch is unit-tested; the orchestration (picker →
 * import → create → open) lives in the app. DOM-free + bridge-free.
 */

import { type Book, BookFormat, emptyReadingState } from "../types/book";
import { type BookRecord, serializeBook } from "./book-codec";

/** The vault entity type id for an imported binary (mirrors the Files app's
 *  manifest — a wire id, so it stays a string constant, not a guess). */
export const FILE_ENTITY_TYPE = "brainstorm/File/v1";

/** Extensions Books can import. PDF reads today (9.21.5); EPUB imports into
 *  the library now and opens once the 9.21.2 reader lands. */
export const IMPORT_EXTENSIONS: readonly string[] = ["pdf", "epub"];

/** The slice of `files.import`'s reply this module persists. Structurally
 *  typed so Books takes no value dependency on `@brainstorm-os/sdk-types`. */
export type ImportedFile = {
	assetId: string;
	contentHash: string;
	size: number;
	mime: string;
	name: string;
};

/** Resolve a book format from a filename, by its trailing extension. Returns
 *  `null` for anything Books can't import (the caller skips it). */
export function formatFromName(name: string): BookFormat | null {
	const lower = name.toLowerCase();
	if (lower.endsWith(".pdf")) return BookFormat.Pdf;
	if (lower.endsWith(".epub")) return BookFormat.Epub;
	return null;
}

/** A display title from a filename: drop any directory prefix and the single
 *  known book extension, leaving the bare basename (`"a/b/Dune.pdf"` →
 *  `"Dune"`). A name with no recognised extension is returned verbatim. */
export function titleFromName(name: string): string {
	const base = name.replace(/^.*[\\/]/, "");
	return base.replace(/\.(pdf|epub)$/i, "");
}

/** The `File/v1` property record for an imported binary. `attachment` is the
 *  fetchable `brainstorm://asset/<id>` URL the reader decodes; `assetId` /
 *  `assetMime` mirror the Files app's shape so the Storage view + any other
 *  consumer reads the same fields. */
export function fileRecordFromImport(reply: ImportedFile): Record<string, unknown> {
	return {
		name: reply.name,
		mime: reply.mime,
		size: reply.size,
		hash: reply.contentHash,
		attachment: `brainstorm://asset/${reply.assetId}`,
		assetId: reply.assetId,
		assetMime: reply.mime,
	};
}

/** Build the `Book/v1` record for a freshly imported file. `spineLength`
 *  stays 0 + `reading` empty — both fill in on first open (the reader
 *  denormalizes page count + progress as the user reads). The id is minted
 *  by the caller so it can pass the same value to `entities.create` (the
 *  Book schema requires `id` mirrored into properties). */
export function bookRecordFromImport(args: {
	id: string;
	fileId: string;
	title: string;
	format: BookFormat;
	now: number;
}): BookRecord {
	const book: Book = {
		id: args.id,
		name: args.title,
		icon: null,
		format: args.format,
		author: "",
		fileId: args.fileId,
		spineLength: 0,
		reading: emptyReadingState(),
		createdAt: args.now,
		updatedAt: args.now,
	};
	return serializeBook(book);
}
