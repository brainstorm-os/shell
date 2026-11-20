/**
 * What a book file IS, decided from its bytes. A filename is a hint the user
 * (or a download site) chose — `Book.fb2.epub`, `book.zip`, a `.epub` that is
 * really a renamed FB2 — so the reader routes on content and only falls back
 * to the name when the bytes are ambiguous.
 */

import { firstStoredEntry, isZip, listZipEntries } from "./zip-reader";

export enum SniffedKind {
	Pdf = "pdf",
	Epub = "epub",
	Fb2 = "fb2",
	/** A ZIP whose payload is a FictionBook (`.fb2.zip`). */
	Fb2Zip = "fb2-zip",
	/** A ZIP that is neither an EPUB nor a zipped FB2. */
	Zip = "zip",
	Unknown = "unknown",
}

export const EPUB_MIME = "application/epub+zip";
const EPUB_MIMETYPE_ENTRY = "mimetype";
const EPUB_CONTAINER_ENTRY = "META-INF/container.xml";
const FB2_ROOT = "<fictionbook";
const PDF_MAGIC = "%PDF-";
/** How much of the head is scanned for a text signature. A PDF may carry
 *  leading junk and an FB2 a long XML prolog; both stay well inside this. */
const HEAD_SCAN_BYTES = 4096;

function latin1(bytes: Uint8Array): string {
	let out = "";
	for (const byte of bytes) out += String.fromCharCode(byte);
	return out;
}

/** The head as text. A UTF-16 file (BOM-marked) is decoded as such so its
 *  root element is still findable; everything else reads byte-for-byte,
 *  which is exact for the ASCII signatures looked for here. */
function headText(bytes: Uint8Array): string {
	const head = bytes.subarray(0, HEAD_SCAN_BYTES);
	const [a, b] = [head[0], head[1]];
	if (a === 0xff && b === 0xfe) return new TextDecoder("utf-16le").decode(head);
	if (a === 0xfe && b === 0xff) return new TextDecoder("utf-16be").decode(head);
	return latin1(head);
}

function sniffZip(bytes: Uint8Array): SniffedKind {
	const first = firstStoredEntry(bytes);
	if (first?.name === EPUB_MIMETYPE_ENTRY && latin1(first.data).trim() === EPUB_MIME) {
		return SniffedKind.Epub;
	}
	const names = listZipEntries(bytes).map((entry) => entry.name);
	// Plenty of converters write the `mimetype` entry compressed or out of
	// order. The container document is what a reader actually needs.
	if (names.includes(EPUB_CONTAINER_ENTRY)) return SniffedKind.Epub;
	if (names.some((name) => name.toLowerCase().endsWith(".fb2"))) return SniffedKind.Fb2Zip;
	return SniffedKind.Zip;
}

export function sniffBookBytes(bytes: Uint8Array): SniffedKind {
	if (isZip(bytes)) return sniffZip(bytes);
	const head = headText(bytes);
	if (head.includes(PDF_MAGIC)) return SniffedKind.Pdf;
	if (head.toLowerCase().includes(FB2_ROOT)) return SniffedKind.Fb2;
	return SniffedKind.Unknown;
}
