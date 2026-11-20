import { describe, expect, it } from "vitest";
import { BookFormat } from "../types/book";
import { makeLocator } from "../types/locator";
import {
	bookFormatFromFile,
	bookFromEntity,
	entityIdFromPayload,
	fileSourceFromEntity,
	readingPositionPatch,
	resolveFileOpen,
	staleFileMimePatch,
} from "./book-open";
import { SniffedKind } from "./book-sniff";

describe("entityIdFromPayload", () => {
	it("reads a string entityId", () => {
		expect(entityIdFromPayload({ entityId: "book-1" })).toBe("book-1");
	});

	it("rejects missing / empty / non-string ids and non-object payloads", () => {
		expect(entityIdFromPayload({})).toBeNull();
		expect(entityIdFromPayload({ entityId: "" })).toBeNull();
		expect(entityIdFromPayload({ entityId: 7 })).toBeNull();
		expect(entityIdFromPayload(null)).toBeNull();
		expect(entityIdFromPayload("book-1")).toBeNull();
	});
});

function pdfBookEntity(overrides: Record<string, unknown> = {}): {
	id: string;
	properties: Record<string, unknown>;
} {
	return {
		id: "book-1",
		properties: {
			name: "Deep Work",
			format: "pdf",
			author: "Cal Newport",
			fileId: "file-9",
			spineLength: 12,
			reading: { position: "bkcfi:/3:0", progress: 0.25, lastReadAt: 1000 },
			createdAt: 1,
			updatedAt: 2,
			...overrides,
		},
	};
}

describe("bookFromEntity", () => {
	it("decodes a Book/v1 row, row id winning over a mirrored properties id", () => {
		const entity = pdfBookEntity({ id: "stale-mirror" });
		const book = bookFromEntity(entity);
		expect(book?.id).toBe("book-1");
		expect(book?.format).toBe(BookFormat.Pdf);
		expect(book?.fileId).toBe("file-9");
		expect(book?.reading.position).toEqual({ spineIndex: 3, charOffset: 0 });
	});

	it("rejects rows without an id or properties", () => {
		expect(bookFromEntity(null)).toBeNull();
		expect(bookFromEntity({ id: "x" })).toBeNull();
		expect(bookFromEntity({ properties: { name: "n" } })).toBeNull();
	});
});

describe("bookFromEntity formats", () => {
	it("round-trips fb2 and reads an unknown format as epub", () => {
		expect(bookFromEntity(pdfBookEntity({ format: "fb2" }))?.format).toBe(BookFormat.Fb2);
		expect(bookFromEntity(pdfBookEntity({ format: "mobi" }))?.format).toBe(BookFormat.Epub);
	});
});

describe("fileSourceFromEntity", () => {
	it("resolves the attachment URL + mime", () => {
		expect(
			fileSourceFromEntity({
				id: "file-9",
				properties: { attachment: "brainstorm://vault-file/abc.pdf", mime: "application/pdf" },
			}),
		).toEqual({ url: "brainstorm://vault-file/abc.pdf", mime: "application/pdf" });
	});

	it("tolerates a missing mime but never a missing URL", () => {
		expect(
			fileSourceFromEntity({ id: "file-9", properties: { attachment: "brainstorm://f" } }),
		).toEqual({ url: "brainstorm://f", mime: null });
		expect(fileSourceFromEntity({ id: "file-9", properties: { mime: "application/pdf" } })).toBe(
			null,
		);
		expect(fileSourceFromEntity(null)).toBeNull();
	});
});

describe("bookFormatFromFile", () => {
	it("maps the PDF / EPUB mime types", () => {
		expect(bookFormatFromFile({ mime: "application/pdf" })).toBe(BookFormat.Pdf);
		expect(bookFormatFromFile({ mime: "application/epub+zip" })).toBe(BookFormat.Epub);
	});

	it("falls back to the filename extension when the mime is generic", () => {
		expect(bookFormatFromFile({ mime: "application/octet-stream", name: "Dune.epub" })).toBe(
			BookFormat.Epub,
		);
		expect(bookFormatFromFile({ name: "paper.pdf" })).toBe(BookFormat.Pdf);
	});

	it("maps the FictionBook mime types", () => {
		expect(bookFormatFromFile({ mime: "application/x-fictionbook+xml" })).toBe(BookFormat.Fb2);
		expect(bookFormatFromFile({ mime: "application/x-zip-compressed-fb2" })).toBe(BookFormat.Fb2);
	});

	it("resolves the owner's already-imported file by its compound name", () => {
		expect(
			bookFormatFromFile({
				mime: "application/octet-stream",
				name: "King_Chetyre-posle-polunochi_3_Bibliotechnaya-policiya.159046.fb2.epub",
			}),
		).toBe(BookFormat.Epub);
		expect(bookFormatFromFile({ mime: "application/zip", name: "King.fb2.zip" })).toBe(
			BookFormat.Fb2,
		);
	});

	it("returns null for non-book files and empty props", () => {
		expect(bookFormatFromFile({ mime: "image/png", name: "shot.png" })).toBeNull();
		expect(bookFormatFromFile(null)).toBeNull();
		expect(bookFormatFromFile({})).toBeNull();
	});
});

describe("staleFileMimePatch", () => {
	const GENERIC = "application/octet-stream";

	it("gives a generically-labelled file the MIME its bytes sniffed as", () => {
		expect(staleFileMimePatch({ mime: GENERIC }, SniffedKind.Epub)).toEqual({
			mime: "application/epub+zip",
		});
		expect(staleFileMimePatch({ mime: GENERIC }, SniffedKind.Fb2)).toEqual({
			mime: "application/x-fictionbook+xml",
		});
		expect(staleFileMimePatch({ mime: "application/zip" }, SniffedKind.Fb2Zip)).toEqual({
			mime: "application/x-zip-compressed-fb2",
		});
		expect(staleFileMimePatch({}, SniffedKind.Pdf)).toEqual({ mime: "application/pdf" });
	});

	it("leaves a specific label alone, right or wrong", () => {
		expect(staleFileMimePatch({ mime: "application/epub+zip" }, SniffedKind.Epub)).toBeNull();
		expect(staleFileMimePatch({ mime: "application/pdf" }, SniffedKind.Epub)).toBeNull();
	});

	it("writes nothing when the bytes are not a book", () => {
		expect(staleFileMimePatch({ mime: GENERIC }, SniffedKind.Zip)).toBeNull();
		expect(staleFileMimePatch({ mime: GENERIC }, SniffedKind.Unknown)).toBeNull();
	});
});

describe("resolveFileOpen", () => {
	it("mints a title without the compound suffix for a conversion download", () => {
		const result = resolveFileOpen({
			fileId: "file-1",
			fileProps: { name: "King.159046.fb2.epub", mime: "application/octet-stream" },
			books: [],
			newBookId: "bk-new",
			now: 5,
		});
		expect(result?.record?.format).toBe(BookFormat.Epub);
		expect(result?.record?.name).toBe("King.159046");
	});

	const fileProps = { name: "Deep Work.pdf", mime: "application/pdf", attachment: "brainstorm://f" };

	it("reuses an existing Book/v1 that already wraps the file", () => {
		const existing = bookFromEntity(pdfBookEntity({ fileId: "file-7" }));
		if (!existing) throw new Error("fixture book failed to parse");
		const result = resolveFileOpen({
			fileId: "file-7",
			fileProps,
			books: [existing],
			newBookId: "bk-new",
			now: 5,
		});
		expect(result).toEqual({ bookId: existing.id, record: null });
	});

	it("mints a Book/v1 record pointing at the file in place when none exists", () => {
		const result = resolveFileOpen({
			fileId: "file-7",
			fileProps,
			books: [],
			newBookId: "bk-new",
			now: 5,
		});
		expect(result?.bookId).toBe("bk-new");
		expect(result?.record?.fileId).toBe("file-7");
		expect(result?.record?.format).toBe(BookFormat.Pdf);
		expect(result?.record?.name).toBe("Deep Work");
		expect(result?.record?.id).toBe("bk-new");
	});

	it("returns null for a file that is not a book format", () => {
		expect(
			resolveFileOpen({
				fileId: "file-7",
				fileProps: { name: "shot.png", mime: "image/png" },
				books: [],
				newBookId: "bk-new",
				now: 5,
			}),
		).toBeNull();
	});
});

describe("readingPositionPatch", () => {
	it("advances the book and emits the wire reading blob + spineLength + updatedAt", () => {
		const book = bookFromEntity(pdfBookEntity());
		if (!book) throw new Error("fixture book failed to parse");
		const { book: advanced, patch } = readingPositionPatch(book, makeLocator(7, 0), 0.5, 16, 9999);
		expect(advanced.reading.position).toEqual(makeLocator(7, 0));
		expect(advanced.spineLength).toBe(16);
		expect(patch).toEqual({
			reading: { position: "bkcfi:/7:0", progress: 0.5, lastReadAt: 9999 },
			spineLength: 16,
			updatedAt: 9999,
		});
	});
});
