/**
 * Import-a-book (9.21.2 import slice) — the pure core of bringing an
 * external EPUB / FB2 / PDF into the vault. The renderer picks a file through the Files host service,
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

/** The FINAL extensions the import picker offers. `zip` is here for zipped
 *  FictionBook (`.fb2.zip`) only — a picker filter cannot express a compound
 *  extension, so `formatFromName` turns any other archive away. */
export const IMPORT_EXTENSIONS: readonly string[] = ["pdf", "epub", "fb2", "zip"];

/** The truthful MIME of each book file shape. This is the LABEL a `File/v1`
 *  row carries (and what the shell routes an `open` on); the asset protocol's
 *  served `Content-Type` is a separate, preview-safe value the shell picks. */
export const BookMime = {
	Pdf: "application/pdf",
	Epub: "application/epub+zip",
	Fb2: "application/x-fictionbook+xml",
	Fb2Zip: "application/x-zip-compressed-fb2",
} as const;

const FB2_ZIP_SUFFIX = ".fb2.zip";

/** Compound and plain book suffixes, longest first, so `Dune.fb2.epub` — what
 *  an FB2→EPUB conversion download is called — titles as `Dune`. */
const TITLE_SUFFIX_RE = /\.(?:fb2\.epub|fb2\.zip|pdf|epub|fb2)$/i;

/** The slice of `files.import`'s reply this module persists. Structurally
 *  typed so Books takes no value dependency on `@brainstorm-os/sdk-types`. */
export type ImportedFile = {
	assetId: string;
	contentHash: string;
	size: number;
	mime: string;
	name: string;
};

/** Resolve a book format from a filename. The FINAL extension decides —
 *  `Dune.fb2.epub` is an EPUB, however many dots precede it — with the one
 *  compound case `.fb2.zip`. Returns `null` for anything Books can't import
 *  (the caller skips it). A name is only a hint: the reader re-decides from
 *  the file's bytes when the book opens. */
export function formatFromName(name: string): BookFormat | null {
	const lower = name.trim().toLowerCase();
	if (lower.endsWith(".pdf")) return BookFormat.Pdf;
	if (lower.endsWith(".epub")) return BookFormat.Epub;
	if (lower.endsWith(".fb2") || lower.endsWith(FB2_ZIP_SUFFIX)) return BookFormat.Fb2;
	return null;
}

/** The truthful MIME for a book filename, or `null` when it is not a book. */
export function bookMimeFromName(name: string): string | null {
	const lower = name.trim().toLowerCase();
	if (lower.endsWith(FB2_ZIP_SUFFIX)) return BookMime.Fb2Zip;
	switch (formatFromName(lower)) {
		case BookFormat.Pdf:
			return BookMime.Pdf;
		case BookFormat.Epub:
			return BookMime.Epub;
		case BookFormat.Fb2:
			return BookMime.Fb2;
		default:
			return null;
	}
}

/** A display title from a filename: drop any directory prefix and the known
 *  book suffix, leaving the bare basename (`"a/b/Dune.pdf"` → `"Dune"`,
 *  `"Dune.fb2.epub"` → `"Dune"`). A name with no recognised extension is
 *  returned verbatim. */
export function titleFromName(name: string): string {
	const base = name.replace(/^.*[\\/]/, "");
	return base.replace(TITLE_SUFFIX_RE, "");
}

/** The `File/v1` property record for an imported binary. `attachment` is the
 *  fetchable `brainstorm://asset/<id>` URL the reader decodes; `assetId` /
 *  `assetMime` mirror the Files app's shape so the Storage view + any other
 *  consumer reads the same fields. `mime` is the truthful label derived from
 *  the name — NOT the shell's served mime, which collapses every book format
 *  but PDF to `application/octet-stream` and left an imported EPUB showing
 *  (and routing) as a generic binary. */
export function fileRecordFromImport(reply: ImportedFile): Record<string, unknown> {
	return {
		name: reply.name,
		mime: bookMimeFromName(reply.name) ?? reply.mime,
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
