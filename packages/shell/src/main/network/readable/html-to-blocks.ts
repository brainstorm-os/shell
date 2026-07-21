/**
 * Sanitized-HTML → Lexical `SerializedBlock[]` (Net-2a) — the last extraction-
 * substrate module. Walks the sanitised article DOM (via `linkedom`, no JS) and
 * hand-emits the **same serialized-node shape the editor's clipboard speaks**
 * (`packages/editor/src/plugins/block-clipboard.ts`), so a captured page drops
 * into a Bookmark's universal body with zero transform (9.18.5).
 *
 * It does NOT import `@brainstorm-os/editor` (that would pull `@lexical/html`,
 * which the editor's own clipboard path deliberately avoids) — it emits the
 * JSON literally. Validity is pinned by the round-trip test, which parses the
 * output into a real `createBrainstormHeadlessEditor`.
 *
 * Allowlist↔block-set equivalence: the tags handled here are exactly
 * `READABLE_ALLOWED_TAGS` (sanitize-html.ts). Unmapped containers flatten to
 * their children; unmapped inline degrades to plain text — never dropped, never
 * carried as raw HTML.
 */

import { parseHTML } from "linkedom";

/** Lexical `exportJSON()` node shape — a recursive tree. Structural (not the
 *  editor's type) so this module stays editor-decoupled; the round-trip test
 *  guarantees it imports. */
export type SerializedBlock = {
	type: string;
	version: number;
	children?: SerializedBlock[];
	[key: string]: unknown;
};

// Lexical TextNode format bitmask (lexical `TextFormatType`).
const FORMAT_BOLD = 1;
const FORMAT_ITALIC = 2;
const FORMAT_CODE = 16;

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/** Belt-and-braces URL gate (Net-2e hardening). In the pipeline `sanitizeReadableHtml`
 *  has already dropped `javascript:`/`data:`/etc., so this is unreachable for
 *  sanitised input — but it keeps `htmlToSerializedBlocks` independently safe if
 *  ever handed raw HTML out-of-order: a non-allowlisted scheme yields no link
 *  (the text survives) / no image. Mirrors the sanitizer's allowlist; relative +
 *  anchor URLs (no scheme) pass. */
function isSafeUrl(url: string): boolean {
	const trimmed = url.trim();
	const scheme = trimmed.match(/^([a-z][a-z0-9+.-]*):/i);
	if (scheme === null) return !trimmed.startsWith("//"); // relative/anchor ok; protocol-relative not
	const s = (scheme[1] ?? "").toLowerCase();
	return s === "http" || s === "https" || s === "mailto" || s === "brainstorm";
}

function textNode(text: string, format: number): SerializedBlock {
	return { type: "text", version: 1, text, format, detail: 0, mode: "normal", style: "" };
}

function elementBlock(
	type: string,
	children: SerializedBlock[],
	extra: Record<string, unknown> = {},
) {
	return { type, version: 1, direction: null, format: "", indent: 0, ...extra, children };
}

const tag = (n: { nodeType: number; tagName?: string }) =>
	n.nodeType === 1 ? (n.tagName ?? "").toLowerCase() : "";

/** Flatten an inline subtree into text / link nodes, accumulating bold/italic/
 *  code formatting down the tree. */
function inlineChildren(
	parent: { childNodes: ArrayLike<unknown> },
	format: number,
): SerializedBlock[] {
	const out: SerializedBlock[] = [];
	for (const raw of Array.from(parent.childNodes) as Array<{
		nodeType: number;
		tagName?: string;
		textContent?: string | null;
		getAttribute?: (n: string) => string | null;
		childNodes: ArrayLike<unknown>;
	}>) {
		if (raw.nodeType === 3) {
			const text = raw.textContent ?? "";
			if (text.length > 0) out.push(textNode(text, format));
			continue;
		}
		if (raw.nodeType !== 1) continue;
		const t = (raw.tagName ?? "").toLowerCase();
		if (t === "br") {
			out.push({ type: "linebreak", version: 1 });
		} else if (t === "strong" || t === "b") {
			out.push(...inlineChildren(raw, format | FORMAT_BOLD));
		} else if (t === "em" || t === "i") {
			out.push(...inlineChildren(raw, format | FORMAT_ITALIC));
		} else if (t === "code") {
			out.push(...inlineChildren(raw, format | FORMAT_CODE));
		} else if (t === "a") {
			const url = raw.getAttribute?.("href") ?? "";
			if (isSafeUrl(url)) {
				const title = raw.getAttribute?.("title");
				out.push(
					elementBlock("link", inlineChildren(raw, format), {
						url,
						rel: null,
						target: null,
						title: title ?? null,
					}),
				);
			} else {
				// Unsafe scheme → drop the link wrapper, keep its text.
				out.push(...inlineChildren(raw, format));
			}
		} else if (t === "img") {
			const img = imageNode(raw);
			if (img !== null) out.push(img);
		} else {
			// Unmapped inline container → flatten its children at the same format.
			out.push(...inlineChildren(raw, format));
		}
	}
	return out;
}

function imageNode(el: { getAttribute?: (n: string) => string | null }): SerializedBlock | null {
	const src = el.getAttribute?.("src") ?? "";
	if (!isSafeUrl(src)) return null; // drop images with a non-allowlisted scheme
	return {
		type: "image",
		version: 1,
		src,
		altText: el.getAttribute?.("alt") ?? "",
		caption: "",
		width: "inherit",
	};
}

function codeLanguage(
	pre: { getAttribute?: (n: string) => string | null },
	code: unknown,
): string | null {
	const fromClass = (cls: string | null | undefined): string | null => {
		const m = (cls ?? "").match(/language-([\w-]+)/);
		return m ? (m[1] ?? null) : null;
	};
	return (
		fromClass(pre.getAttribute?.("class")) ??
		fromClass((code as { getAttribute?: (n: string) => string | null })?.getAttribute?.("class")) ??
		null
	);
}

function listBlock(el: {
	tagName?: string;
	childNodes: ArrayLike<unknown>;
}): SerializedBlock {
	const ordered = (el.tagName ?? "").toLowerCase() === "ol";
	const items: SerializedBlock[] = [];
	let value = 1;
	for (const raw of Array.from(el.childNodes) as Array<
		{ nodeType: number; tagName?: string } & {
			childNodes: ArrayLike<unknown>;
		}
	>) {
		if (raw.nodeType === 1 && (raw.tagName ?? "").toLowerCase() === "li") {
			items.push(elementBlock("listitem", inlineChildren(raw, 0), { value }));
			value += 1;
		}
	}
	return elementBlock("list", items, {
		listType: ordered ? "number" : "bullet",
		start: 1,
		tag: ordered ? "ol" : "ul",
	});
}

/** Convert one top-level element to zero or more blocks. */
function blockFromElement(el: {
	nodeType: number;
	tagName?: string;
	textContent?: string | null;
	getAttribute?: (n: string) => string | null;
	childNodes: ArrayLike<unknown>;
	querySelector?: (s: string) => unknown;
}): SerializedBlock[] {
	if (el.nodeType === 3) {
		const text = (el.textContent ?? "").trim();
		return text.length > 0 ? [elementBlock("paragraph", [textNode(text, 0)])] : [];
	}
	if (el.nodeType !== 1) return [];
	const t = (el.tagName ?? "").toLowerCase();

	if (HEADING_TAGS.has(t)) return [elementBlock("heading", inlineChildren(el, 0), { tag: t })];
	if (t === "p") return [elementBlock("paragraph", inlineChildren(el, 0))];
	if (t === "blockquote") return [elementBlock("quote", inlineChildren(el, 0))];
	if (t === "ul" || t === "ol") return [listBlock(el)];
	if (t === "img") {
		const img = imageNode(el);
		return img !== null ? [elementBlock("paragraph", [img])] : [];
	}
	if (t === "hr") return [];
	if (t === "pre") {
		const code = el.querySelector?.("code");
		const text = el.textContent ?? "";
		return [
			elementBlock("code", text.length > 0 ? [textNode(text, 0)] : [], {
				language: codeLanguage(el, code),
			}),
		];
	}
	// Unmapped container (article, section, div, figure, table, …) → recurse its
	// children so nested allowed blocks survive. Bare inline content under it
	// collapses into a paragraph.
	const blocks: SerializedBlock[] = [];
	let inlineRun: SerializedBlock[] = [];
	const flushInline = () => {
		if (inlineRun.length > 0) {
			blocks.push(elementBlock("paragraph", inlineRun));
			inlineRun = [];
		}
	};
	for (const raw of Array.from(el.childNodes) as Array<Parameters<typeof blockFromElement>[0]>) {
		const childTag = tag(raw);
		const isBlock =
			raw.nodeType === 1 &&
			(HEADING_TAGS.has(childTag) ||
				["p", "blockquote", "ul", "ol", "pre", "hr", "img", "figure", "table"].includes(childTag) ||
				// recurse generic containers
				!["a", "strong", "b", "em", "i", "code", "span", "br"].includes(childTag));
		if (isBlock) {
			flushInline();
			blocks.push(...blockFromElement(raw));
		} else {
			inlineRun.push(...inlineChildren({ childNodes: [raw] }, 0));
		}
	}
	flushInline();
	return blocks;
}

export function htmlToSerializedBlocks(html: string): SerializedBlock[] {
	if (typeof html !== "string" || html.trim().length === 0) return [];
	// linkedom only populates `document.body` when the full <html> scaffold is
	// present — a bare <body> wrapper parses to an empty body.
	const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
	const body = document.body as unknown as { childNodes: ArrayLike<unknown> };
	const blocks: SerializedBlock[] = [];
	for (const raw of Array.from(body.childNodes) as Array<Parameters<typeof blockFromElement>[0]>) {
		blocks.push(...blockFromElement(raw));
	}
	return blocks;
}
