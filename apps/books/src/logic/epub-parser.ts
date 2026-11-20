/**
 * EPUB parser (9.21.2, OQ-BK-1 hybrid) — the thin epub.js glue. Opens the EPUB
 * archive from its bytes, walks the spine, loads each section's XHTML, and hands
 * the markup to the pure `bookContentFrom` extractor → `BookContent`. epub.js is
 * used ONLY as the archive/spine parser; its iframe `Rendition` (which conflicts
 * with the per-app sandbox CSP) is never instantiated.
 *
 * The extraction logic it delegates to lives in the jsdom-tested
 * `epub-content.ts`, and the navigation-label matching in the pure, tested
 * `epub-nav.ts`. `epub-parser.test.ts` drives this glue over small EPUB
 * archives built in the test (a converter-style book, and archives that must
 * fail fast); a real downloaded EPUB is only ever exercised in the real shell.
 *
 * epub.js (a heavy CJS lib + JSZip) is **dynamically imported** so it stays out
 * of the app's initial bundle/module graph — it loads only when a user actually
 * opens an EPUB (the PDF + library paths never pull it).
 */

import type { BookContent } from "./content";
import { type RawSection, bodyMarkup, bookContentFrom } from "./epub-content";
import { type NavEntry, navigationTitles, titleForHref } from "./epub-nav";

/** How long the table of contents may take once the spine is in hand. A book
 *  whose navigation never arrives still opens — with headings for titles. */
const NAVIGATION_WAIT_MS = 2000;

type ParsedSection = {
	localName?: string;
	querySelector?: (selector: string) => Element | null;
	innerHTML?: string;
};

const PARSE_ERROR_TAG = "parsererror";

function isParseErrorDocument(doc: ParsedSection | null | undefined): boolean {
	if (!doc) return false;
	return doc.localName === PARSE_ERROR_TAG || Boolean(doc.querySelector?.(PARSE_ERROR_TAG));
}

function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | null> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => resolve(null), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

type NavigationLoader = { loadNavigation?: (packaging: unknown) => Promise<unknown> };

/** epub.js loads the navigation document with no rejection handler, so an
 *  OPF that names an NCX the archive lacks is an unhandled rejection AND a
 *  `loaded.navigation` that never settles. Turning that failure into "no
 *  navigation" lets the load finish; the open has not started yet (it is
 *  async), so the wrapped loader is the one it calls. */
function tolerateMissingNavigation(book: NavigationLoader): void {
	const load = book.loadNavigation;
	if (typeof load !== "function") return;
	book.loadNavigation = (packaging) =>
		load.call(book, packaging).catch((error: unknown) => {
			console.warn("[books] epub navigation unavailable:", error);
			return null;
		});
}

/** Parse `bytes` (an EPUB file) into the reflow reader's `BookContent`. */
export async function parseEpub(bytes: Uint8Array): Promise<BookContent> {
	const { default: ePub } = await import("epubjs");
	const buffer = bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
	const book = ePub(buffer);
	tolerateMissingNavigation(book as unknown as NavigationLoader);
	try {
		// Wait for the package + spine only — NOT `book.ready`. `ready` also
		// waits on the navigation document, and epub.js leaves it pending
		// forever when the OPF names an NCX the archive lacks; it likewise
		// never rejects when the archive will not open (it emits `openFailed`).
		// Either way the reader could only see a 25-second "Opening book…"
		// timeout for a book that was readable, or knowably broken, at once.
		await new Promise<void>((resolve, reject) => {
			book.on("openFailed", (error: unknown) =>
				reject(error instanceof Error ? error : new Error("the EPUB archive would not open")),
			);
			Promise.all([book.loaded.spine, book.loaded.metadata]).then(() => resolve(), reject);
		});
		const metadata = book.packaging?.metadata;
		const meta = { title: metadata?.title ?? "", author: metadata?.creator ?? "" };
		// The NCX / nav-doc labels are the book's OWN chapter titles. Without
		// them every chapter fell back to a positional "Chapter N", which is
		// what the TOC showed. A book with no navigation document is normal —
		// the extractor then falls back to the section's first heading.
		let titles: ReadonlyMap<string, string> = new Map();
		try {
			const navigation = (await settleWithin(book.loaded.navigation, NAVIGATION_WAIT_MS)) as {
				toc?: readonly NavEntry[];
			} | null;
			titles = navigationTitles(navigation?.toc ?? []);
		} catch (error) {
			console.warn("[books] epub navigation unavailable:", error);
		}
		const sections: RawSection[] = [];
		for (let i = 0; ; i += 1) {
			const section = book.spine.get(i);
			if (!section) break;
			try {
				// epub.js `section.load()` resolves to the section's `<html>`
				// ELEMENT (`section.contents = documentElement`), not a Document —
				// so `.body` is undefined. Read the body via `querySelector`
				// (works on both an Element and a Document), falling back to the
				// element's own markup (htmlToBlocks skips <head> anyway).
				const doc = (await section.load(book.load.bind(book))) as ParsedSection | null | undefined;
				const body = doc?.querySelector?.("body");
				let html = body?.innerHTML ?? doc?.innerHTML ?? "";
				// epub.js parses a section as strict XML. One stray `&nbsp;` or
				// bare `&` makes that a parse-error document: the chapter is cut
				// off at the error (or replaced by the error text). The raw
				// markup, read leniently, still has the whole chapter.
				if (isParseErrorDocument(doc)) {
					const raw = await book.archive?.getText?.(section.url);
					if (typeof raw === "string") html = bodyMarkup(raw);
				}
				sections.push({ title: titleForHref(titles, section.href), html });
			} catch (error) {
				console.warn(`[books] epub section ${i} load failed:`, error);
			} finally {
				section.unload();
			}
		}
		return bookContentFrom(meta, sections);
	} finally {
		book.destroy();
	}
}
