import { describe, expect, it } from "vitest";
import { BookFormat } from "../types/book";
import {
	BookMime,
	FILE_ENTITY_TYPE,
	IMPORT_EXTENSIONS,
	bookMimeFromName,
	bookRecordFromImport,
	fileRecordFromImport,
	formatFromName,
	titleFromName,
} from "./book-import";

describe("formatFromName", () => {
	it("maps a .pdf to PDF and .epub to EPUB, case-insensitively", () => {
		expect(formatFromName("Dune.pdf")).toBe(BookFormat.Pdf);
		expect(formatFromName("Dune.PDF")).toBe(BookFormat.Pdf);
		expect(formatFromName("Dune.epub")).toBe(BookFormat.Epub);
		expect(formatFromName("Dune.EPUB")).toBe(BookFormat.Epub);
	});

	it("decides by the FINAL extension of a compound name", () => {
		// The owner's file: an FB2→EPUB conversion download. It is an EPUB.
		const owner = "King_Chetyre-posle-polunochi_3_Bibliotechnaya-policiya.159046.fb2.epub";
		expect(formatFromName(owner)).toBe(BookFormat.Epub);
		expect(formatFromName("a.b.c.d.EPUB")).toBe(BookFormat.Epub);
		expect(formatFromName("Report.v2.final.Pdf")).toBe(BookFormat.Pdf);
		expect(formatFromName("  Dune.epub  ")).toBe(BookFormat.Epub);
		// …and the reverse: an `.epub` in the middle of a name is not the format.
		expect(formatFromName("Dune.epub.txt")).toBeNull();
		expect(formatFromName("Dune.epub.pdf")).toBe(BookFormat.Pdf);
	});

	it("maps FictionBook, plain and zipped", () => {
		expect(formatFromName("King.fb2")).toBe(BookFormat.Fb2);
		expect(formatFromName("King.FB2")).toBe(BookFormat.Fb2);
		expect(formatFromName("King.159046.fb2.zip")).toBe(BookFormat.Fb2);
		expect(formatFromName("King.Fb2.ZIP")).toBe(BookFormat.Fb2);
	});

	it("returns null for an unimportable extension", () => {
		expect(formatFromName("notes.txt")).toBeNull();
		expect(formatFromName("cover.png")).toBeNull();
		expect(formatFromName("no-extension")).toBeNull();
		expect(formatFromName(".epub")).toBe(BookFormat.Epub);
		// A zip is only a book when it says it holds an FB2.
		expect(formatFromName("photos.zip")).toBeNull();
	});

	it("advertises exactly the final extensions it can import", () => {
		expect([...IMPORT_EXTENSIONS].sort()).toEqual(["epub", "fb2", "pdf", "zip"]);
		for (const ext of IMPORT_EXTENSIONS) {
			expect(formatFromName(`book.fb2.${ext}`)).not.toBeNull();
		}
	});
});

describe("bookMimeFromName", () => {
	it("labels each book shape truthfully", () => {
		expect(bookMimeFromName("Dune.pdf")).toBe(BookMime.Pdf);
		expect(bookMimeFromName("Dune.fb2.epub")).toBe(BookMime.Epub);
		expect(bookMimeFromName("Dune.fb2")).toBe(BookMime.Fb2);
		expect(bookMimeFromName("Dune.fb2.zip")).toBe(BookMime.Fb2Zip);
	});

	it("has no label for a non-book", () => {
		expect(bookMimeFromName("photos.zip")).toBeNull();
		expect(bookMimeFromName("notes.txt")).toBeNull();
	});
});

describe("titleFromName", () => {
	it("strips a directory prefix and the book extension", () => {
		expect(titleFromName("Dune.pdf")).toBe("Dune");
		expect(titleFromName("a/b/Thinking Fast and Slow.epub")).toBe("Thinking Fast and Slow");
		expect(titleFromName("C:\\books\\Dune.PDF")).toBe("Dune");
	});

	it("keeps dots that are not the trailing book extension", () => {
		expect(titleFromName("Vol.2 - Dune.pdf")).toBe("Vol.2 - Dune");
	});

	it("drops a compound conversion suffix whole", () => {
		expect(titleFromName("King.159046.fb2.epub")).toBe("King.159046");
		expect(titleFromName("King.159046.fb2.zip")).toBe("King.159046");
		expect(titleFromName("King.159046.FB2")).toBe("King.159046");
	});

	it("returns the basename verbatim when no book extension matches", () => {
		expect(titleFromName("a/b/manuscript")).toBe("manuscript");
	});
});

describe("fileRecordFromImport", () => {
	it("builds an attachment URL from the asset id and mirrors the Files shape", () => {
		const record = fileRecordFromImport({
			assetId: "asset-123",
			contentHash: "hash-abc",
			size: 4096,
			mime: "application/pdf",
			name: "Dune.pdf",
		});
		expect(record).toEqual({
			name: "Dune.pdf",
			mime: "application/pdf",
			size: 4096,
			hash: "hash-abc",
			attachment: "brainstorm://asset/asset-123",
			assetId: "asset-123",
			assetMime: "application/pdf",
		});
	});
});

describe("fileRecordFromImport — the label is the truth, not the served mime", () => {
	// The shell serves every book format but PDF as `application/octet-stream`
	// (a security posture for the asset protocol). Copying that into the row's
	// `mime` is what made an imported EPUB a paperclip "octet-stream" in Files.
	const served = "application/octet-stream";
	const reply = (name: string) => ({
		assetId: "a1",
		contentHash: "h",
		size: 10,
		mime: served,
		name,
	});

	it("labels an EPUB as an EPUB while keeping the served mime separate", () => {
		const record = fileRecordFromImport(reply("King.159046.fb2.epub"));
		expect(record.mime).toBe(BookMime.Epub);
		expect(record.assetMime).toBe(served);
	});

	it("labels FB2 and zipped FB2", () => {
		expect(fileRecordFromImport(reply("King.fb2")).mime).toBe(BookMime.Fb2);
		expect(fileRecordFromImport(reply("King.fb2.zip")).mime).toBe(BookMime.Fb2Zip);
	});

	it("falls back to the served mime for a name it does not know", () => {
		expect(fileRecordFromImport(reply("mystery.bin")).mime).toBe(served);
	});
});

describe("bookRecordFromImport", () => {
	it("links the file, parks reading state empty, and mirrors the id", () => {
		const record = bookRecordFromImport({
			id: "bk-1",
			fileId: "fil-1",
			title: "Dune",
			format: BookFormat.Pdf,
			now: 1000,
		});
		expect(record.id).toBe("bk-1");
		expect(record.fileId).toBe("fil-1");
		expect(record.name).toBe("Dune");
		expect(record.format).toBe(BookFormat.Pdf);
		expect(record.author).toBe("");
		expect(record.spineLength).toBe(0);
		expect(record.reading).toEqual({ position: null, progress: 0, lastReadAt: null });
		expect(record.createdAt).toBe(1000);
		expect(record.updatedAt).toBe(1000);
	});
});

describe("FILE_ENTITY_TYPE", () => {
	it("is the canonical File wire id", () => {
		expect(FILE_ENTITY_TYPE).toBe("brainstorm/File/v1");
	});
});
