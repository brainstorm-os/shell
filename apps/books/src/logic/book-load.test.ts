// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { BookFormat } from "../types/book";
import {
	BookOpenError,
	BookOpenFailure,
	failureOf,
	formatOfSniff,
	loadReflowBook,
} from "./book-load";
import { SniffedKind, sniffBookBytes } from "./book-sniff";
import { BlockKind, type BookContent } from "./content";
import { buildZip } from "./zip-fixture";

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const FB2 =
	"<FictionBook><body><section><title><p>Глава</p></title><p>Текст.</p></section></body></FictionBook>";

const epubContent: BookContent = {
	title: "T",
	author: "A",
	spine: [{ title: "One", blocks: [{ kind: BlockKind.Paragraph, text: "Hello" }] }],
};
const neverEpub = { parseEpub: vi.fn(() => Promise.reject(new Error("must not be called"))) };

async function failure(attempt: Promise<unknown>): Promise<BookOpenFailure | null> {
	try {
		await attempt;
		return null;
	} catch (error) {
		return error instanceof BookOpenError ? error.failure : null;
	}
}

describe("formatOfSniff", () => {
	it("maps every readable kind to its catalog format", () => {
		expect(formatOfSniff(SniffedKind.Pdf)).toBe(BookFormat.Pdf);
		expect(formatOfSniff(SniffedKind.Epub)).toBe(BookFormat.Epub);
		expect(formatOfSniff(SniffedKind.Fb2)).toBe(BookFormat.Fb2);
		expect(formatOfSniff(SniffedKind.Fb2Zip)).toBe(BookFormat.Fb2);
	});

	it("has no format for a plain zip or unknown bytes", () => {
		expect(formatOfSniff(SniffedKind.Zip)).toBeNull();
		expect(formatOfSniff(SniffedKind.Unknown)).toBeNull();
	});
});

describe("loadReflowBook", () => {
	it("hands an EPUB to the EPUB parser", async () => {
		const parseEpub = vi.fn(() => Promise.resolve(epubContent));
		const bytes = utf8("epub bytes");
		const book = await loadReflowBook(bytes, SniffedKind.Epub, { parseEpub });
		expect(parseEpub).toHaveBeenCalledWith(bytes);
		expect(book).toEqual({ format: BookFormat.Epub, content: epubContent, cover: null });
	});

	it("parses a plain FB2 without touching the EPUB parser", async () => {
		const book = await loadReflowBook(utf8(FB2), SniffedKind.Fb2, neverEpub);
		expect(book.format).toBe(BookFormat.Fb2);
		expect(book.content.spine[0]?.blocks.map((b) => b.text)).toEqual(["Глава", "Текст."]);
		expect(neverEpub.parseEpub).not.toHaveBeenCalled();
	});

	it("unzips and parses a .fb2.zip", async () => {
		const zipped = buildZip([
			{ name: "readme.txt", data: "ignore me" },
			{ name: "King.fb2", data: FB2, deflate: true },
		]);
		expect(sniffBookBytes(zipped)).toBe(SniffedKind.Fb2Zip);
		const book = await loadReflowBook(zipped, SniffedKind.Fb2Zip, neverEpub);
		expect(book.format).toBe(BookFormat.Fb2);
		expect(book.content.spine[0]?.title).toBe("Глава");
	});

	it("reports an unreadable kind as Unsupported", async () => {
		expect(await failure(loadReflowBook(utf8("x"), SniffedKind.Zip, neverEpub))).toBe(
			BookOpenFailure.Unsupported,
		);
		expect(await failure(loadReflowBook(utf8("x"), SniffedKind.Unknown, neverEpub))).toBe(
			BookOpenFailure.Unsupported,
		);
	});

	it("reports a parser that throws as Damaged", async () => {
		const parseEpub = vi.fn(() => Promise.reject(new Error("Cannot load book")));
		expect(await failure(loadReflowBook(utf8("x"), SniffedKind.Epub, { parseEpub }))).toBe(
			BookOpenFailure.Damaged,
		);
		expect(await failure(loadReflowBook(utf8("<html/>"), SniffedKind.Fb2, neverEpub))).toBe(
			BookOpenFailure.Damaged,
		);
	});

	it("reports a book with no text as Empty rather than mounting a blank reader", async () => {
		const blank: BookContent = { title: "T", author: "", spine: [{ title: "T", blocks: [] }] };
		const parseEpub = vi.fn(() => Promise.resolve(blank));
		expect(await failure(loadReflowBook(utf8("x"), SniffedKind.Epub, { parseEpub }))).toBe(
			BookOpenFailure.Empty,
		);
		expect(
			await failure(
				loadReflowBook(utf8("<FictionBook><body/></FictionBook>"), SniffedKind.Fb2, neverEpub),
			),
		).toBe(BookOpenFailure.Empty);
	});
});

describe("failureOf", () => {
	it("keeps a typed failure and reads anything else as Missing", () => {
		expect(failureOf(new BookOpenError(BookOpenFailure.TimedOut, "slow"))).toBe(
			BookOpenFailure.TimedOut,
		);
		expect(failureOf(new Error("fetch 404"))).toBe(BookOpenFailure.Missing);
		expect(failureOf("nope")).toBe(BookOpenFailure.Missing);
	});
});
