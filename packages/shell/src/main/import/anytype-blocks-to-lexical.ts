/**
 * Anytype block tree → Lexical `ImportedBodyState`.
 *
 * The intermediate markdown path (render → markdown → plant) mangled
 * structure (lists, headings, marks). This walks Anytype's block graph
 * and emits the same serialized shapes Notes/Journal plant via
 * `plantSerializedStateIntoDoc` (paragraph / heading / list / quote /
 * code / hr / image / link).
 *
 * Pure — no vault, no I/O. Side effects are the three callbacks for
 * mentions, page-links, and file embeds (so the importer can still build
 * its link graph).
 */

import type { ImportedBodyState } from "./plant-import-body";

export type AnytypeBlockHandlers = {
	readonly onMention: (target: string) => void;
	readonly onLinkBlock: (target: string) => void;
	readonly onFileBlock: (fileObjectId: string, name: string | null, image: boolean) => void;
	/** Resolve an object id to a display name (for link blocks). */
	readonly nameOf?: (id: string) => string | null;
	/** Resolve a file object id to a body src URL (e.g. brainstorm://asset/…);
	 *  falls back to the file name when absent. */
	readonly fileSrcOf?: (fileObjectId: string, name: string | null) => string | null;
};

type SerializedNode = {
	type: string;
	// image-block serializes at v2; every other emitted node is v1.
	version: 1 | 2;
	[key: string]: unknown;
};

type Mark = {
	readonly from: number;
	readonly to: number;
	readonly type: string;
	readonly param: string;
};

const CHROME_BLOCK_IDS: ReadonlySet<string> = new Set([
	"header",
	"title",
	"description",
	"featuredRelations",
]);

const HEADER_TAGS: Readonly<Record<string, string>> = {
	Header1: "h1",
	Header2: "h2",
	Header3: "h3",
	Header4: "h4",
};

/** Lexical text format bitfield (mirrors `@lexical/text`). */
const FMT = {
	Bold: 1,
	Italic: 2,
	Strikethrough: 4,
	Code: 16,
} as const;

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function textNode(text: string, format = 0): SerializedNode {
	return {
		type: "text",
		version: 1,
		detail: 0,
		format,
		mode: "normal",
		style: "",
		text,
	};
}

function linkNode(url: string, children: SerializedNode[]): SerializedNode {
	return {
		type: "link",
		version: 1,
		rel: null,
		target: null,
		title: null,
		url,
		children,
	};
}

function paragraph(children: SerializedNode[]): SerializedNode {
	return {
		type: "paragraph",
		version: 1,
		format: "",
		indent: 0,
		direction: null,
		children: children.length > 0 ? children : [textNode("")],
	};
}

function heading(tag: string, children: SerializedNode[]): SerializedNode {
	return {
		type: "heading",
		version: 1,
		tag,
		format: "",
		indent: 0,
		direction: null,
		children: children.length > 0 ? children : [textNode("")],
	};
}

function quote(children: SerializedNode[]): SerializedNode {
	return {
		type: "quote",
		version: 1,
		format: "",
		indent: 0,
		direction: null,
		children: [paragraph(children)],
	};
}

function codeBlock(code: string): SerializedNode {
	return {
		type: "code",
		version: 1,
		language: "",
		format: "",
		indent: 0,
		direction: null,
		children: code.length > 0 ? [textNode(code)] : [],
	};
}

function hr(): SerializedNode {
	return { type: "horizontalrule", version: 1 };
}

/** Anytype stores a media block's display width in `fields.width` as a
 *  FRACTION of the editor width (0..1]; absent means full width. Clamp to
 *  the editor's media range so a corrupt value can't zero the image. */
function widthPercentOf(fields: unknown): number {
	const width = asRecord(fields)?.width;
	if (typeof width !== "number" || !Number.isFinite(width) || width <= 0) return 100;
	return Math.min(100, Math.max(10, Math.round(width * 100)));
}

/** Emit the editor's resizable `image-block` (NOT the bare inline `image`
 *  node, which renders at natural size — imported screenshots showed up
 *  page-width huge). Width carries over from the Anytype block. */
function imageNode(src: string, alt: string, widthPercent = 100): SerializedNode {
	return {
		type: "image-block",
		version: 2,
		src,
		alt,
		caption: "",
		alignment: "center",
		widthPercent,
	};
}

function listItem(
	children: SerializedNode[],
	opts?: { checked?: boolean; nested?: SerializedNode[] },
): SerializedNode {
	const body: SerializedNode[] = [paragraph(children)];
	if (opts?.nested && opts.nested.length > 0) body.push(...opts.nested);
	const item: SerializedNode = {
		type: "listitem",
		version: 1,
		value: 1,
		format: "",
		indent: 0,
		direction: null,
		children: body,
	};
	if (opts?.checked !== undefined) item.checked = opts.checked;
	return item;
}

function list(listType: "bullet" | "number" | "check", items: SerializedNode[]): SerializedNode {
	return {
		type: "list",
		version: 1,
		listType,
		start: 1,
		tag: listType === "number" ? "ol" : "ul",
		format: "",
		indent: 0,
		direction: null,
		children: items,
	};
}

function parseMarks(text: Record<string, unknown>): Mark[] {
	const wrapper = asRecord(text.marks);
	const raw = wrapper && Array.isArray(wrapper.marks) ? wrapper.marks : [];
	const marks: Mark[] = [];
	for (const entry of raw) {
		const mark = asRecord(entry);
		if (!mark) continue;
		const range = asRecord(mark.range);
		const from = typeof range?.from === "number" ? range.from : 0;
		const to = typeof range?.to === "number" ? range.to : 0;
		const type = asString(mark.type);
		if (!type || to <= from) continue;
		marks.push({ from, to, type, param: asString(mark.param) ?? "" });
	}
	return marks;
}

/** Build inline Lexical nodes from Anytype text + marks. Mentions fire
 *  `onMention` for graph edges but stay as plain text labels in the body
 *  (the destination may not be imported yet). */
function inlinesFromText(
	raw: string,
	marks: readonly Mark[],
	onMention: (target: string) => void,
): SerializedNode[] {
	if (raw.length === 0) return [textNode("")];
	// Sort + flatten mark ranges into non-overlapping segments with a format
	// bitmask + optional link URL.
	type Boundary = { at: number; start: boolean; mark: Mark };
	const bounds: Boundary[] = [];
	for (const m of marks) {
		if (m.type === "Mention" || m.type === "Object") {
			if (m.param) onMention(m.param);
			continue; // mention stays as plain text of the covered run
		}
		bounds.push({ at: m.from, start: true, mark: m });
		bounds.push({ at: m.to, start: false, mark: m });
	}
	bounds.sort((a, b) => a.at - b.at || (a.start === b.start ? 0 : a.start ? 1 : -1));

	const out: SerializedNode[] = [];
	const active = new Set<Mark>();
	let cursor = 0;
	let bi = 0;
	const flush = (to: number): void => {
		if (to <= cursor) return;
		const slice = raw.slice(cursor, to);
		let format = 0;
		let linkUrl: string | null = null;
		for (const m of active) {
			if (m.type === "Bold") format |= FMT.Bold;
			else if (m.type === "Italic") format |= FMT.Italic;
			else if (m.type === "Strikethrough") format |= FMT.Strikethrough;
			else if (m.type === "Keyboard" || m.type === "Code") format |= FMT.Code;
			else if (m.type === "Link" && m.param) linkUrl = m.param;
		}
		const node = textNode(slice, format);
		if (linkUrl) out.push(linkNode(linkUrl, [node]));
		else out.push(node);
		cursor = to;
	};
	while (bi < bounds.length) {
		const at = bounds[bi]?.at ?? raw.length;
		flush(at);
		while (bi < bounds.length && bounds[bi]?.at === at) {
			const b = bounds[bi] as Boundary;
			if (b.start) active.add(b.mark);
			else active.delete(b.mark);
			bi++;
		}
	}
	flush(raw.length);
	return out.length > 0 ? out : [textNode("")];
}

function plainSnippet(nodes: readonly SerializedNode[]): string {
	const parts: string[] = [];
	const walk = (n: SerializedNode): void => {
		if (n.type === "text" && typeof n.text === "string") parts.push(n.text);
		if (Array.isArray(n.children)) for (const c of n.children as SerializedNode[]) walk(c);
	};
	for (const n of nodes) walk(n);
	return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 280);
}

type ListKind = "bullet" | "number" | "check";

function listKindOf(style: string): ListKind | null {
	if (style === "Marked" || style === "Toggle") return "bullet";
	if (style === "Numbered") return "number";
	if (style === "Checkbox") return "check";
	return null;
}

/**
 * Convert an Anytype object body into a Lexical editor state + search snippet.
 * `rootChildren` is the ordered list of top-level block ids under the object's
 * root (typically `childrenIds` of the smartblock root).
 */
export function anytypeBlocksToLexical(
	byId: ReadonlyMap<string, Record<string, unknown>>,
	rootChildren: readonly string[],
	handlers: AnytypeBlockHandlers,
): { state: ImportedBodyState; snippet: string } {
	const visited = new Set<string>();
	const rootNodes: SerializedNode[] = [];

	const convertTextBlock = (
		block: Record<string, unknown>,
		text: Record<string, unknown>,
	): { node: SerializedNode | null; listKind: ListKind | null; checked?: boolean } => {
		const style = asString(text.style) ?? "Paragraph";
		const raw = typeof text.text === "string" ? text.text : "";
		const children = inlinesFromText(raw, parseMarks(text), handlers.onMention);
		const listKind = listKindOf(style);
		if (listKind) {
			const nested = convertChildren(stringArray(block.childrenIds));
			const nestedLists = nested.filter((n) => n.type === "list");
			const nestedOther = nested.filter((n) => n.type !== "list");
			// Non-list nested children become extra paragraphs inside the item.
			const itemChildren = [...children];
			// Nested content: other blocks as siblings after the item paragraph
			// are attached via listitem children (paragraph + nested list).
			const checked = listKind === "check" ? text.checked === true : undefined;
			const item = listItem(itemChildren, {
				...(checked !== undefined ? { checked } : {}),
				nested: [...nestedLists, ...nestedOther.map((n) => (n.type === "paragraph" ? n : n))],
			});
			return { node: item, listKind, ...(checked !== undefined ? { checked } : {}) };
		}
		const headerTag = HEADER_STYLES_TAG(style);
		if (headerTag) return { node: heading(headerTag, children), listKind: null };
		if (style === "Quote" || style === "Callout") return { node: quote(children), listKind: null };
		if (style === "Code") return { node: codeBlock(raw), listKind: null };
		if (style === "Title" || style === "Description") return { node: null, listKind: null };
		if (raw.length === 0 && stringArray(block.childrenIds).length === 0) {
			return { node: null, listKind: null };
		}
		return { node: paragraph(children), listKind: null };
	};

	function HEADER_STYLES_TAG(style: string): string | null {
		return HEADER_TAGS[style] ?? null;
	}

	const convertOne = (id: string): SerializedNode | SerializedNode[] | null => {
		if (visited.has(id) || CHROME_BLOCK_IDS.has(id)) return null;
		visited.add(id);
		const block = byId.get(id);
		if (!block) return null;

		const text = asRecord(block.text);
		const file = asRecord(block.file);
		const link = asRecord(block.link);
		const bookmark = asRecord(block.bookmark);
		const div = asRecord(block.div);

		if (div) return hr();

		if (text) {
			const { node, listKind } = convertTextBlock(block, text);
			if (listKind && node) {
				// Caller groups consecutive list items — return a tagged single item.
				return node;
			}
			if (node) {
				const nested = convertChildren(stringArray(block.childrenIds));
				return nested.length > 0 ? [node, ...nested] : node;
			}
			return convertChildren(stringArray(block.childrenIds));
		}

		if (file) {
			const target = asString(file.targetObjectId) ?? asString(file.hash);
			const name = asString(file.name);
			const isImage = file.type === "Image";
			if (target) handlers.onFileBlock(target, name, isImage);
			const src = (target ? handlers.fileSrcOf?.(target, name) : null) ?? name ?? target ?? "";
			if (isImage && src) return imageNode(src, name ?? src, widthPercentOf(block.fields));
			if (name || src) {
				return paragraph([linkNode(src || name || "#", [textNode(name ?? src)])]);
			}
			return null;
		}

		if (link) {
			const target = asString(link.targetBlockId);
			if (target) {
				handlers.onLinkBlock(target);
				const label = handlers.nameOf?.(target) ?? target;
				return paragraph([textNode(label)]);
			}
			return null;
		}

		if (bookmark) {
			const url = asString(bookmark.url);
			if (url) {
				const title = asString(bookmark.title) ?? url;
				return paragraph([linkNode(url, [textNode(title)])]);
			}
			return null;
		}

		// Tables / dataview / unknown — walk children for any text content.
		return convertChildren(stringArray(block.childrenIds));
	};

	/** Anytype's client splices layout-`Div` wrappers inline BEFORE numbering
	 *  (`updateNumbersTree`'s `unwrap`): a numbered run split across invisible
	 *  Div wrappers is ONE consecutive run. Mirror it here or each wrapper
	 *  opens a fresh grouping scope and every item renders as "1." (F-443).
	 *  Row/Column layouts deliberately keep their own scope — the client
	 *  restarts numbering per cell too. */
	function flattenLayoutDivs(ids: readonly string[]): string[] {
		const out: string[] = [];
		for (const id of ids) {
			if (visited.has(id) || CHROME_BLOCK_IDS.has(id)) continue;
			const block = byId.get(id);
			const layout = block ? asRecord(block.layout) : null;
			if (layout && asString(layout.style) === "Div" && block) {
				visited.add(id);
				out.push(...flattenLayoutDivs(stringArray(block.childrenIds)));
			} else {
				out.push(id);
			}
		}
		return out;
	}

	function convertChildren(rawIds: readonly string[]): SerializedNode[] {
		const ids = flattenLayoutDivs(rawIds);
		const out: SerializedNode[] = [];
		let i = 0;
		while (i < ids.length) {
			const id = ids[i] as string;
			const block = byId.get(id);
			const text = block ? asRecord(block.text) : null;
			const style = text ? (asString(text.style) ?? "Paragraph") : null;
			const kind = style ? listKindOf(style) : null;

			if (kind) {
				// Group consecutive list items of the same kind.
				const items: SerializedNode[] = [];
				while (i < ids.length) {
					const nid = ids[i] as string;
					const nb = byId.get(nid);
					const nt = nb ? asRecord(nb.text) : null;
					const ns = nt ? (asString(nt.style) ?? "Paragraph") : null;
					if (!ns || listKindOf(ns) !== kind) break;
					const converted = convertOne(nid);
					if (converted) {
						if (Array.isArray(converted)) {
							for (const c of converted) {
								if (c.type === "listitem") items.push(c);
								else out.push(c);
							}
						} else if (converted.type === "listitem") {
							items.push(converted);
						} else {
							out.push(converted);
						}
					}
					i++;
				}
				if (items.length > 0) out.push(list(kind, items));
				continue;
			}

			const converted = convertOne(id);
			if (converted) {
				if (Array.isArray(converted)) out.push(...converted);
				else out.push(converted);
			}
			i++;
		}
		return out;
	}

	rootNodes.push(...convertChildren(rootChildren));
	if (rootNodes.length === 0) rootNodes.push(paragraph([textNode("")]));

	const state = {
		root: {
			type: "root",
			version: 1,
			format: "",
			indent: 0,
			direction: null,
			children: rootNodes,
		},
	} as unknown as ImportedBodyState;

	return { state, snippet: plainSnippet(rootNodes) };
}

/** Unix-seconds Anytype detail → ms epoch, or null when missing/invalid. */
export function anytypeDateToMs(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		// Heuristic: values below 1e12 are seconds (Anytype export); above are ms.
		return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
	}
	if (typeof value === "string" && value.length > 0) {
		const n = Number(value);
		if (Number.isFinite(n) && n > 0) return anytypeDateToMs(n);
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}
