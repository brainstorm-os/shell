/**
 * Open-a-book resolution (9.21.5) — the pure half of the launch path. The
 * shell's only guaranteed delivery on a fresh launch is the handshake
 * `{ reason: "open-entity", entityId }` (the same contract Preview resolves
 * against), so Books turns a bare id into a `Book` via the capability-gated
 * `entities.get`, then — for a PDF — resolves the backing `File/v1` row to
 * the `brainstorm:` URL whose bytes the engine decodes. Bytes never cross
 * the preload bridge; the URL is the only transportable form.
 *
 * DOM-free + bridge-free so every branch is unit-tested.
 */

import { type Book, BookFormat } from "../types/book";
import type { Locator } from "../types/locator";
import { type BookRecord, parseBook, serializeBook, withReadingPosition } from "./book-codec";
import { BookMime, bookRecordFromImport, formatFromName, titleFromName } from "./book-import";
import { SniffedKind } from "./book-sniff";

/** The slice of an `entities.get` row this resolver reads — structurally
 *  typed so Books takes no cross-package type dependency. */
export type OpenableEntity = {
	id?: unknown;
	properties?: Record<string, unknown> | null;
};

function readString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/** Pull the target entity id off a launch handshake / intent payload. */
export function entityIdFromPayload(payload: unknown): string | null {
	if (!payload || typeof payload !== "object") return null;
	return readString((payload as { entityId?: unknown }).entityId);
}

/** Decode a `Book/v1` row. The entity's own id wins over any `id` mirrored
 *  into properties (the row id is the authoritative one). */
export function bookFromEntity(entity: OpenableEntity | null | undefined): Book | null {
	if (!entity) return null;
	const id = readString(entity.id);
	const props = entity.properties;
	if (!id || !props || typeof props !== "object") return null;
	return parseBook({ ...props, id } as Parameters<typeof parseBook>[0]);
}

const FORMAT_BY_MIME: Readonly<Record<string, BookFormat>> = {
	[BookMime.Pdf]: BookFormat.Pdf,
	[BookMime.Epub]: BookFormat.Epub,
	[BookMime.Fb2]: BookFormat.Fb2,
	[BookMime.Fb2Zip]: BookFormat.Fb2,
};

/** Book format implied by a `File/v1`'s `mime` / `name` — the bridge that
 *  lets a raw book file invoked from the Files app open in Books. A book MIME
 *  wins; the filename is the fallback, and it is what resolves the many
 *  existing rows that were stored as `application/octet-stream` before EPUB
 *  and FB2 had a label of their own. */
export function bookFormatFromFile(
	props: Record<string, unknown> | null | undefined,
): BookFormat | null {
	const mime = readString(props?.mime);
	const byMime = mime ? FORMAT_BY_MIME[mime] : undefined;
	if (byMime) return byMime;
	const name = readString(props?.name);
	return name ? formatFromName(name) : null;
}

const MIME_BY_SNIFF: Readonly<Partial<Record<SniffedKind, string>>> = {
	[SniffedKind.Pdf]: BookMime.Pdf,
	[SniffedKind.Epub]: BookMime.Epub,
	[SniffedKind.Fb2]: BookMime.Fb2,
	[SniffedKind.Fb2Zip]: BookMime.Fb2Zip,
};

/** MIME values that say nothing about what a file is. */
const UNINFORMATIVE_MIMES: ReadonlySet<string> = new Set([
	"application/octet-stream",
	"application/zip",
]);

/** The `File/v1` patch that corrects a stale label once the file's BYTES have
 *  been read as a book: a row with no MIME, or one that says only "binary" /
 *  "zip", gains the truthful book MIME. A row that already names a specific
 *  type is left alone — this heals a missing label, it does not overrule one.
 *  `null` when there is nothing to correct. */
export function staleFileMimePatch(
	props: Record<string, unknown> | null | undefined,
	sniffed: SniffedKind,
): Record<string, unknown> | null {
	const truthful = MIME_BY_SNIFF[sniffed];
	if (!truthful) return null;
	const stored = readString(props?.mime);
	if (stored !== null && !UNINFORMATIVE_MIMES.has(stored)) return null;
	return { mime: truthful };
}

/** Resolve an open invoked on a `brainstorm/File/v1` (a book file the user
 *  opened from Files) to the `Book/v1` that should mount. Reuses the catalog
 *  record that already wraps the file; otherwise mints one pointing at the
 *  file in place (no byte re-import — the `File/v1` is the source of truth).
 *  `record: null` means "open the existing book"; a record means "create it
 *  first, then open `bookId`". Returns `null` when the file isn't a book. */
export function resolveFileOpen(args: {
	fileId: string;
	fileProps: Record<string, unknown> | null | undefined;
	books: readonly Book[];
	newBookId: string;
	now: number;
}): { bookId: string; record: BookRecord | null } | null {
	const existing = args.books.find((b) => b.fileId === args.fileId);
	if (existing) return { bookId: existing.id, record: null };
	const format = bookFormatFromFile(args.fileProps);
	if (!format) return null;
	const name = readString(args.fileProps?.name) ?? "";
	const record = bookRecordFromImport({
		id: args.newBookId,
		fileId: args.fileId,
		title: titleFromName(name) || name,
		format,
		now: args.now,
	});
	return { bookId: args.newBookId, record };
}

export type BookFileSource = {
	url: string;
	mime: string | null;
};

/** Resolve a `brainstorm/File/v1` row to its fetchable URL. A row without
 *  a usable `attachment` URL resolves to `null` — the reader shows its
 *  honest "couldn't open" state rather than a broken surface. */
export function fileSourceFromEntity(
	entity: OpenableEntity | null | undefined,
): BookFileSource | null {
	const props = entity?.properties;
	if (!props || typeof props !== "object") return null;
	const url = readString(props.attachment);
	if (!url) return null;
	return { url, mime: readString(props.mime) };
}

/** Advance a book's reading state and produce the `entities.update` patch
 *  that persists it (the wire `reading` blob + denormalized `spineLength`
 *  so the library can render progress without re-opening the document).
 *  Returns the advanced `Book` so the host chains subsequent turns off it. */
export function readingPositionPatch(
	book: Book,
	locator: Locator,
	progress: number,
	spineLength: number,
	now: number,
): { book: Book; patch: Record<string, unknown> } {
	const advanced = { ...withReadingPosition(book, locator, progress, now), spineLength };
	const record = serializeBook(advanced);
	return {
		book: advanced,
		patch: {
			reading: record.reading,
			spineLength: record.spineLength,
			updatedAt: record.updatedAt,
		},
	};
}
