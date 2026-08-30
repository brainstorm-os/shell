/**
 * EPUB → `BookContent` extraction (9.21.2, OQ-BK-1 hybrid). epub.js is used
 * ONLY as the parser (open the archive, resolve the spine + per-section XHTML +
 * metadata — see `epub-parser.ts`); this module turns each section's XHTML into
 * the renderer-agnostic `BookContent` the existing reflow reader / pagination /
 * typography / highlights already consume. epub.js's own iframe `Rendition` is
 * never used (it conflicts with the per-app sandbox CSP).
 *
 * Pure (DOM-only via `DOMParser`) so it is fully jsdom-unit-testable without the
 * epub.js dependency or a real EPUB.
 */

import { BlockKind, type BookContent, type ContentBlock, type SpineItem } from "./content";

/** A raw spine section handed in by the epub.js glue: the chapter title (or "")
 *  and its XHTML body markup. */
export type RawSection = {
	title: string;
	html: string;
};

const HEADING_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);
const BLOCK_TAGS = new Set(["P", "LI", "BLOCKQUOTE", "DD", "DT", "FIGCAPTION"]);
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "HEAD"]);

/** Tags whose text belongs to the surrounding block, never to a block of their
 *  own. Without this list the walker treated `<span>`/`<a>` as generic
 *  containers and descended past their text, dropping it on the floor. */
const INLINE_TAGS = new Set([
	"A",
	"ABBR",
	"B",
	"BDI",
	"BDO",
	"BIG",
	"BR",
	"CITE",
	"CODE",
	"DEL",
	"EM",
	"FONT",
	"I",
	"IMG",
	"INS",
	"KBD",
	"MARK",
	"NOBR",
	"Q",
	"RUBY",
	"S",
	"SAMP",
	"SMALL",
	"SPAN",
	"STRIKE",
	"STRONG",
	"SUB",
	"SUP",
	"TIME",
	"TT",
	"U",
	"VAR",
	"WBR",
]);

/**
 * Chapter titles are not always `<h1>`–`<h6>`. FB2→EPUB converters — the
 * dominant source of Russian-language EPUBs, and common well beyond them —
 * emit `<div class="title2">ГЛАВА ПЕРВАЯ</div>`, and Calibre-style pipelines
 * emit `<p class="chapter-title">`. Matching the class as well as the tag is
 * what keeps those books' headings instead of silently flattening every
 * chapter into unbroken prose.
 */
const TITLE_CLASS_RE = /(?:^|[\s_-])(?:title|subtitle|head(?:er|ing)?|chapter)\d*(?:[\s_-]|$)/i;

/** Collapse runs of whitespace (incl. newlines from the source markup) to single
 *  spaces and trim — the reflow renderer owns visual wrapping. */
function normalizeText(raw: string): string {
	return raw.replace(/\s+/g, " ").trim();
}

/** Heading or paragraph, decided by tag first and then by the title-ish class
 *  the converter left behind. */
function blockKindFor(node: Element): BlockKind {
	if (HEADING_TAGS.has(node.tagName.toUpperCase())) return BlockKind.Heading;
	return TITLE_CLASS_RE.test(node.getAttribute("class") ?? "")
		? BlockKind.Heading
		: BlockKind.Paragraph;
}

/**
 * Extract reflowable blocks from a section's XHTML. Headings (`h1`–`h6`, or a
 * title-classed element) become {@link BlockKind.Heading}; paragraph-like
 * blocks (`p`, `li`, `blockquote`, …) become {@link BlockKind.Paragraph}. The
 * walk descends through generic containers (`div`/`section`/`article`) but
 * never re-emits text already claimed by a nested block, so content isn't
 * duplicated — and a container's own loose text is emitted in document order
 * rather than dropped. Empty blocks drop.
 */
export function htmlToBlocks(html: string): ContentBlock[] {
	const doc = new DOMParser().parseFromString(html, "text/html");
	const blocks: ContentBlock[] = [];

	const visit = (node: Element): void => {
		const tag = node.tagName.toUpperCase();
		if (SKIP_TAGS.has(tag)) return;
		if (HEADING_TAGS.has(tag) || BLOCK_TAGS.has(tag)) {
			const text = normalizeText(node.textContent ?? "");
			if (text) blocks.push({ kind: blockKindFor(node), text });
			return;
		}
		// Generic container. Its own text runs (bare text nodes + inline
		// elements) are real content and become blocks in document order;
		// nested block-level children are descended into.
		let pending = "";
		const flush = (): void => {
			const text = normalizeText(pending);
			pending = "";
			if (text) blocks.push({ kind: blockKindFor(node), text });
		};
		for (const child of Array.from(node.childNodes)) {
			if (child.nodeType === Node.TEXT_NODE) {
				pending += child.nodeValue ?? "";
				continue;
			}
			if (child.nodeType !== Node.ELEMENT_NODE) continue;
			const el = child as Element;
			if (INLINE_TAGS.has(el.tagName.toUpperCase())) {
				pending += el.textContent ?? "";
				continue;
			}
			flush();
			visit(el);
		}
		flush();
	};

	const root = doc.body ?? doc.documentElement;
	for (const child of Array.from(root.children)) visit(child);

	// Fallback: a section with bare text and no block elements (rare, malformed)
	// still yields one paragraph rather than an empty chapter.
	if (blocks.length === 0) {
		const text = normalizeText(root.textContent ?? "");
		if (text) blocks.push({ kind: BlockKind.Paragraph, text });
	}
	return blocks;
}

/** The chapter title for a section: the EPUB's own navigation label when the
 *  parser resolved one, else the section's first heading block, else a
 *  positional fallback numbered by the section's place in the *kept* spine
 *  (cover/nav pages drop out before this, so the count has no holes). */
function titleFor(section: RawSection, blocks: readonly ContentBlock[], position: number): string {
	if (section.title) return section.title;
	const heading = blocks.find((b) => b.kind === BlockKind.Heading);
	if (heading) return heading.text;
	return `Chapter ${position}`;
}

/** Build `BookContent` from EPUB metadata + the parsed spine sections. Sections
 *  with no extractable text are dropped (cover/nav pages), but at least one
 *  empty spine item is kept so the reader never mounts an empty book. */
export function bookContentFrom(
	meta: { title: string; author: string },
	sections: readonly RawSection[],
): BookContent {
	const spine: SpineItem[] = [];
	for (const section of sections) {
		const blocks = htmlToBlocks(section.html);
		if (blocks.length === 0) continue;
		spine.push({ title: titleFor(section, blocks, spine.length + 1), blocks });
	}
	if (spine.length === 0) spine.push({ title: meta.title || "Untitled", blocks: [] });
	return {
		title: meta.title || "Untitled",
		author: meta.author || "",
		spine,
	};
}
