/**
 * FictionBook 2 (`.fb2`) → `BookContent`. FB2 is one XML document: a
 * `<description>` (title, authors, cover reference), one or more `<body>`
 * trees of nested `<section>`s, and base64 `<binary>` attachments.
 *
 * The file is untrusted. Three things keep it inert:
 *  - the DOCTYPE is removed and every named entity reference outside XML's
 *    five built-ins is escaped BEFORE parsing, so no entity — internal,
 *    external, or recursive — is ever expanded;
 *  - the model is built from parsed nodes through an element allowlist; an
 *    element that is not on it contributes nothing, text included;
 *  - the output is plain text blocks. No markup survives, and the reader
 *    writes text, never HTML.
 */

import { BlockKind, type BookContent, type ContentBlock, type SpineItem } from "./content";
import { UNTITLED_BOOK, normalizeText, positionalChapterTitle } from "./epub-content";

export type Fb2Cover = {
	bytes: Uint8Array;
	/** A filename carrying the image's extension — the cover store keys its
	 *  allow-list off it. */
	fileName: string;
};

export type Fb2Book = {
	content: BookContent;
	cover: Fb2Cover | null;
};

const ROOT_TAG = "fictionbook";
const DEFAULT_ENCODING = "utf-8";
const DECLARATION_SCAN_BYTES = 256;
const MAX_COVER_BASE64_CHARS = 16 * 1024 * 1024;

const COVER_EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/png": "png",
	"image/gif": "gif",
	"image/webp": "webp",
};

/** Inline elements whose text belongs to the surrounding block. `image` is
 *  deliberately absent: it has no text, and the model carries no pictures. */
const INLINE_TAGS = new Set(["emphasis", "strong", "strikethrough", "sub", "sup", "code", "a"]);
const HEADING_TAGS = new Set(["title", "subtitle"]);
const PARAGRAPH_TAGS = new Set(["p", "v", "text-author"]);
const CONTAINER_TAGS = new Set(["epigraph", "cite", "poem", "stanza", "annotation"]);

/** Windows-1251 0x80–0xBF. The upper half (0xC0–0xFF) is the contiguous
 *  А–я run. Used only where the platform decoder lacks the label; Chromium
 *  has it, so in the shell this table is never consulted. */
const CP1251_HIGH: readonly number[] = [
	0x0402, 0x0403, 0x201a, 0x0453, 0x201e, 0x2026, 0x2020, 0x2021, 0x20ac, 0x2030, 0x0409, 0x2039,
	0x040a, 0x040c, 0x040b, 0x040f, 0x0452, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
	0x0098, 0x2122, 0x0459, 0x203a, 0x045a, 0x045c, 0x045b, 0x045f, 0x00a0, 0x040e, 0x045e, 0x0408,
	0x00a4, 0x0490, 0x00a6, 0x00a7, 0x0401, 0x00a9, 0x0404, 0x00ab, 0x00ac, 0x00ad, 0x00ae, 0x0407,
	0x00b0, 0x00b1, 0x0406, 0x0456, 0x0491, 0x00b5, 0x00b6, 0x00b7, 0x0451, 0x2116, 0x0454, 0x00bb,
	0x0458, 0x0405, 0x0455, 0x0457,
];
const CP1251_LABELS = new Set(["windows-1251", "cp1251", "win-1251", "x-cp1251", "cp-1251"]);

function decodeCp1251(bytes: Uint8Array): string {
	const units = new Uint16Array(bytes.byteLength);
	for (let i = 0; i < bytes.byteLength; i += 1) {
		const byte = bytes[i] ?? 0;
		if (byte < 0x80) units[i] = byte;
		else if (byte < 0xc0) units[i] = CP1251_HIGH[byte - 0x80] ?? 0xfffd;
		else units[i] = 0x0410 + (byte - 0xc0);
	}
	let out = "";
	const CHUNK = 0x8000;
	for (let at = 0; at < units.length; at += CHUNK) {
		out += String.fromCharCode(...units.subarray(at, at + CHUNK));
	}
	return out;
}

/** The encoding the file declares: a byte-order mark wins, then the XML
 *  declaration's `encoding`, then UTF-8 (the XML default). */
export function declaredFb2Encoding(bytes: Uint8Array): string {
	const [a, b, c] = [bytes[0], bytes[1], bytes[2]];
	if (a === 0xef && b === 0xbb && c === 0xbf) return DEFAULT_ENCODING;
	if (a === 0xff && b === 0xfe) return "utf-16le";
	if (a === 0xfe && b === 0xff) return "utf-16be";
	let head = "";
	for (const byte of bytes.subarray(0, DECLARATION_SCAN_BYTES)) head += String.fromCharCode(byte);
	const match = /<\?xml[^>]*\bencoding\s*=\s*["']([\w.:-]+)["']/i.exec(head);
	return match?.[1]?.toLowerCase() ?? DEFAULT_ENCODING;
}

/** Decode the file's bytes with the encoding it declares. An unknown label
 *  degrades to UTF-8 rather than failing the whole book. */
export function decodeFb2Text(bytes: Uint8Array): string {
	const encoding = declaredFb2Encoding(bytes);
	try {
		return new TextDecoder(encoding).decode(bytes);
	} catch {
		if (CP1251_LABELS.has(encoding)) return decodeCp1251(bytes);
		return new TextDecoder(DEFAULT_ENCODING).decode(bytes);
	}
}

const DOCTYPE_RE = /<!DOCTYPE[^>[]*(?:\[[\s\S]*?\]\s*)?>/gi;
const UNSAFE_ENTITY_RE = /&(?!(?:amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6});)/g;

/** Make the markup safe to hand to an XML parser: no DOCTYPE (so no entity
 *  is ever declared) and no reference to anything but XML's built-ins (so a
 *  declaration that survived the strip could still never be expanded). The
 *  second rule also repairs the bare `&` and `&nbsp;` that real files carry. */
export function neutralizeFb2Markup(xml: string): string {
	return xml.replace(DOCTYPE_RE, "").replace(UNSAFE_ENTITY_RE, "&amp;");
}

function tagOf(el: Element): string {
	return el.localName.toLowerCase();
}

function childElements(el: Element, tag?: string): Element[] {
	const out: Element[] = [];
	for (const child of Array.from(el.children)) {
		if (tag === undefined || tagOf(child) === tag) out.push(child);
	}
	return out;
}

function firstChild(el: Element | null | undefined, tag: string): Element | null {
	return el ? (childElements(el, tag)[0] ?? null) : null;
}

/** Text of a block: its own text nodes plus allowlisted inline elements. */
function inlineText(el: Element): string {
	let out = "";
	for (const node of Array.from(el.childNodes)) {
		if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) {
			out += node.nodeValue ?? "";
		} else if (node.nodeType === Node.ELEMENT_NODE && INLINE_TAGS.has(tagOf(node as Element))) {
			out += inlineText(node as Element);
		}
	}
	return out;
}

function blockText(el: Element): string {
	return normalizeText(inlineText(el));
}

/** A `<title>` is a run of `<p>` lines ("Part One" / "The Arrival"); they
 *  read as one heading. A title with bare text is taken as-is. */
function headingText(el: Element): string {
	const lines = childElements(el, "p").map(blockText).filter(Boolean);
	return lines.length > 0 ? lines.join(" ") : blockText(el);
}

function tableBlocks(table: Element, out: ContentBlock[]): void {
	for (const row of childElements(table, "tr")) {
		const cells = childElements(row)
			.filter((cell) => tagOf(cell) === "td" || tagOf(cell) === "th")
			.map(blockText)
			.filter(Boolean);
		if (cells.length > 0) out.push({ kind: BlockKind.Paragraph, text: cells.join(" | ") });
	}
}

/** Append the reflowable blocks for one non-section element. */
function collectBlocks(el: Element, out: ContentBlock[]): void {
	const tag = tagOf(el);
	if (HEADING_TAGS.has(tag)) {
		const text = tag === "title" ? headingText(el) : blockText(el);
		if (text) out.push({ kind: BlockKind.Heading, text });
		return;
	}
	if (PARAGRAPH_TAGS.has(tag)) {
		const text = blockText(el);
		if (text) out.push({ kind: BlockKind.Paragraph, text });
		return;
	}
	if (tag === "table") {
		tableBlocks(el, out);
		return;
	}
	if (CONTAINER_TAGS.has(tag)) {
		for (const child of childElements(el)) collectBlocks(child, out);
	}
}

/**
 * Flatten a `<body>` / `<section>` tree into spine items, one per section, in
 * document order. The reader's model has no hierarchy, so nesting becomes a
 * flat list that still names every level:
 *
 *  - a section's own content is one chapter, titled by ITS `<title>`;
 *  - each nested section is its own chapter, listed after its parent;
 *  - a section that is only a title ("Part One") is a title page of its own,
 *    so the part is in the contents and no chapter loses its title to it;
 *  - the body's `<title>` is the BOOK's title, not a chapter. It heads an
 *    opening page only when the body has front matter (an epigraph) to put
 *    under it; otherwise it is dropped and the first chapter leads.
 *
 * Text that follows a nested section is kept as a further untitled chapter
 * rather than re-using its parent's title for a second contents entry.
 */
function walkSection(node: Element, spine: SpineItem[], isBody: boolean, bookTitle: string): void {
	const titleEl = firstChild(node, "title");
	let title = titleEl ? headingText(titleEl) : "";
	if (isBody && !title) title = bookTitle;
	let own: ContentBlock[] = [];
	const flush = (): void => {
		const blocks = own;
		own = [];
		if (blocks.length === 0) return;
		const hasProse = blocks.some((block) => block.kind === BlockKind.Paragraph);
		if (isBody && !hasProse) return;
		const heading = isBody ? undefined : blocks.find((block) => block.kind === BlockKind.Heading);
		spine.push({
			title: title || heading?.text || positionalChapterTitle(spine.length + 1),
			blocks,
		});
		title = "";
	};
	for (const child of childElements(node)) {
		if (tagOf(child) === "section") {
			flush();
			walkSection(child, spine, false, bookTitle);
		} else {
			collectBlocks(child, own);
		}
	}
	flush();
}

/** A notes body holds one tiny section per footnote. Reading it as chapters
 *  would bury the table of contents under hundreds of "1", "2", "3" entries,
 *  so the whole body becomes one chapter with each note as a paragraph led
 *  by its number. */
function notesItem(body: Element, position: number): SpineItem | null {
	const blocks: ContentBlock[] = [];
	const title = firstChild(body, "title");
	const titleText = title ? headingText(title) : "";
	if (titleText) blocks.push({ kind: BlockKind.Heading, text: titleText });
	const visit = (section: Element): void => {
		const own: ContentBlock[] = [];
		for (const child of childElements(section)) {
			if (tagOf(child) === "section") visit(child);
			else collectBlocks(child, own);
		}
		let label = "";
		for (const block of own) {
			if (block.kind === BlockKind.Heading) {
				label = label ? `${label} ${block.text}` : block.text;
				continue;
			}
			blocks.push({
				kind: BlockKind.Paragraph,
				text: label ? `${label} ${block.text}` : block.text,
			});
			label = "";
		}
	};
	for (const section of childElements(body, "section")) visit(section);
	if (blocks.every((block) => block.kind === BlockKind.Heading)) return null;
	return { title: titleText || positionalChapterTitle(position), blocks };
}

function personName(author: Element): string {
	const part = (tag: string): string => {
		const el = firstChild(author, tag);
		return el ? blockText(el) : "";
	};
	const full = [part("first-name"), part("middle-name"), part("last-name")]
		.filter(Boolean)
		.join(" ");
	return full || part("nickname");
}

function hrefOf(el: Element): string {
	for (const attr of Array.from(el.attributes)) {
		if (attr.localName.toLowerCase() === "href") return attr.value;
	}
	return "";
}

function decodeBase64(raw: string): Uint8Array | null {
	const compact = raw.replace(/\s+/g, "");
	if (compact.length === 0 || compact.length > MAX_COVER_BASE64_CHARS) return null;
	try {
		const binary = atob(compact);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
		return bytes;
	} catch {
		return null;
	}
}

function coverFrom(root: Element, titleInfo: Element | null): Fb2Cover | null {
	const image = firstChild(firstChild(titleInfo, "coverpage"), "image");
	const href = image ? hrefOf(image) : "";
	if (!href.startsWith("#")) return null;
	const id = href.slice(1);
	const binary = childElements(root, "binary").find((el) => el.getAttribute("id") === id);
	if (!binary) return null;
	const mime = (binary.getAttribute("content-type") ?? "").trim().toLowerCase();
	const extension = COVER_EXTENSION_BY_MIME[mime];
	if (!extension) return null;
	const bytes = decodeBase64(binary.textContent ?? "");
	return bytes ? { bytes, fileName: `cover.${extension}` } : null;
}

function findRoot(doc: Document): Element | null {
	const root = doc.documentElement;
	if (root && tagOf(root) === ROOT_TAG) return root;
	for (const el of Array.from(doc.getElementsByTagName("*"))) {
		if (tagOf(el) === ROOT_TAG) return el;
	}
	return null;
}

/** Parse FB2 markup (already decoded to a string). Throws when the document
 *  has no `<FictionBook>` root — the caller reports that as a damaged file. */
export function parseFb2Markup(xml: string): Fb2Book {
	const doc = new DOMParser().parseFromString(neutralizeFb2Markup(xml), "application/xml");
	const root = findRoot(doc);
	if (!root) throw new Error("not a FictionBook document");

	const titleInfo = firstChild(firstChild(root, "description"), "title-info");
	const bookTitle = firstChild(titleInfo, "book-title");
	const title = bookTitle ? blockText(bookTitle) : "";
	const author = titleInfo
		? childElements(titleInfo, "author").map(personName).filter(Boolean).join(", ")
		: "";

	const spine: SpineItem[] = [];
	childElements(root, "body").forEach((body, index) => {
		if (index > 0 && body.hasAttribute("name")) {
			const notes = notesItem(body, spine.length + 1);
			if (notes) spine.push(notes);
			return;
		}
		walkSection(body, spine, true, title);
	});
	if (spine.length === 0) spine.push({ title: title || UNTITLED_BOOK, blocks: [] });

	return {
		content: { title: title || UNTITLED_BOOK, author, spine },
		cover: coverFrom(root, titleInfo),
	};
}

/** Parse an `.fb2` file's bytes, honouring its declared encoding. */
export function parseFb2(bytes: Uint8Array): Fb2Book {
	return parseFb2Markup(decodeFb2Text(bytes));
}
