/**
 * `serializedStateToHtml` — B11.12 export: a `SerializedEditorState` → a
 * portable, **escaped** HTML string. The string twin of `renderEditorState`
 * (the in-app React preview): same block vocabulary, but emits standalone
 * semantic HTML (no `bs-editor__*` classes — exported HTML can't rely on our
 * stylesheet) and is security-hardened for export — every text + attribute
 * value is HTML-escaped and link/image URLs pass a scheme allowlist, so an
 * exported file opened in a browser can't run smuggled `javascript:` URLs or
 * inject markup. Pure (no DOM, no Lexical) so the escaping + structure are
 * exhaustively unit-testable.
 *
 * Markdown export already round-trips via `@lexical/markdown`; this fills the
 * HTML half. The shared `TextFormat` bit table + serialized-node types are
 * reused from `preview.ts` rather than re-declared.
 */

import { blockBackgroundExportCss } from "./block-background";
import { safeExternalHref } from "./plugins/embed-providers";
import { type SerializedEditorStateLike, type SerializedNode, TextFormat } from "./preview";

/** URL schemes safe to keep in an exported `href`/`src`. Anything else (incl.
 *  `javascript:`, `data:` for links, `vbscript:`) is dropped — the anchor
 *  renders without an href rather than carrying an executable URL. */
const SAFE_URL_SCHEME = /^(https?:|mailto:|tel:|brainstorm:|#|\/|\.)/i;
const ENTITY_URL_PREFIX = "brainstorm://entity/";
const ASSET_URL_PREFIX = "brainstorm://asset/";
/** Raster only: an SVG `data:` image is a document that can carry script. */
const DATA_IMAGE_URL = /^data:image\/(png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=]+$/;
/** Deeper than any document a person writes; past it a node is flattened to
 *  its text instead of recursing until the stack gives out. */
const MAX_RENDER_DEPTH = 64;
/** A vault URL anywhere in a string, up to the first delimiter. */
const VAULT_URL = /brainstorm:[^\s<>"')\]]*/gi;
const VAULT_SCHEME = "brainstorm:";
/** The id inside a vault URL (`brainstorm://entity/<id>`, `…/asset/<id>`). */
const VAULT_URL_ID = /brainstorm:\/\/[a-z-]+\/([A-Za-z0-9_-]+)/gi;
/** Shorter than any real id; below it a match is just a word. */
const MIN_SENSITIVE_ID_CHARS = 8;
const MAX_DECODE_PASSES = 3;

export type SerializeHtmlOptions = {
	maxBlocks?: number;
	/** Publishing mode (IE-12). Maps an entity id to the relative href of its
	 *  published page, or `null` when the entity is not published. When set, no
	 *  `brainstorm:` URL and no id the body references reaches the output, in
	 *  any string the serializer emits; a reference to an unpublished entity
	 *  keeps neither its link nor its stored label; and an image is emitted
	 *  only from `resolveAssetSrc` or an allowed `data:` URL, never a remote one. */
	resolveEntityHref?: (entityId: string) => string | null;
	/** The current title of a published page, shown in place of the label a
	 *  reference stored when it was written. */
	resolveEntityLabel?: (entityId: string) => string | null;
	/** Maps a `brainstorm://asset/<id>` image to the relative path of its
	 *  copied file, or `null` to drop the image. */
	resolveAssetSrc?: (assetId: string) => string | null;
	/** Text standing in for a mention / page reference whose target is not
	 *  published. Its stored label is the target's title, so it is never used. */
	unpublishedLabel?: string;
	/** Keep inline raster `data:` images — all of them, or those a predicate
	 *  admits (a publisher holding them to a size budget). */
	allowDataImages?: boolean | ((url: string) => boolean);
};

type RenderContext = SerializeHtmlOptions & {
	/** Ids the body references (publishing mode only) — scrubbed wherever they
	 *  would otherwise be emitted. */
	sensitiveIds: readonly string[];
};

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function str(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function asNodes(value: unknown): SerializedNode[] {
	return Array.isArray(value) ? (value as SerializedNode[]) : [];
}

function standIn(ctx: RenderContext): string {
	return ctx.unpublishedLabel ?? "";
}

/** Every id a body references: `entityId` properties and the id inside any
 *  vault URL held in any string property. */
function collectSensitiveIds(root: SerializedNode): string[] {
	const ids = new Set<string>();
	const add = (id: string) => {
		if (id.length >= MIN_SENSITIVE_ID_CHARS) ids.add(id);
	};
	const pending: SerializedNode[] = [root];
	for (let node = pending.pop(); node; node = pending.pop()) {
		for (const [key, value] of Object.entries(node)) {
			if (typeof value !== "string") continue;
			if (key === "entityId") add(value);
			for (const match of value.matchAll(VAULT_URL_ID)) add(match[1] ?? "");
		}
		for (const child of asNodes(node.children)) pending.push(child);
	}
	return [...ids].sort((a, b) => b.length - a.length);
}

type Range = { start: number; end: number };

/** Where vault URLs and referenced ids sit in a string, merged and ordered. */
function sensitiveRanges(text: string, ctx: RenderContext): Range[] {
	const found: Range[] = [];
	for (const match of text.matchAll(VAULT_URL)) {
		found.push({ start: match.index, end: match.index + match[0].length });
	}
	for (const id of ctx.sensitiveIds) {
		for (let at = text.indexOf(id); at !== -1; at = text.indexOf(id, at + id.length)) {
			found.push({ start: at, end: at + id.length });
		}
	}
	found.sort((a, b) => a.start - b.start);
	const merged: Range[] = [];
	for (const range of found) {
		const last = merged[merged.length - 1];
		if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
		else merged.push({ ...range });
	}
	return merged;
}

/** Scrubs consecutive text runs as ONE string, so a URL or id that formatting
 *  split across runs is still found whole. Returns each run's remaining text;
 *  the stand-in lands in the run where the match began. */
function scrubRuns(runs: readonly string[], ctx: RenderContext): string[] {
	if (!ctx.resolveEntityHref) return [...runs];
	const joined = runs.join("");
	const ranges = sensitiveRanges(joined, ctx);
	if (ranges.length === 0) return [...runs];
	let offset = 0;
	return runs.map((run) => {
		const runStart = offset;
		const runEnd = offset + run.length;
		offset = runEnd;
		let out = "";
		let at = runStart;
		for (const { start, end } of ranges) {
			if (end <= runStart || start >= runEnd) continue;
			if (start >= runStart) out += `${joined.slice(at, start)}${standIn(ctx)}`;
			at = Math.min(runEnd, end);
		}
		return `${out}${joined.slice(at, runEnd)}`;
	});
}

/** THE escape boundary: every string that becomes text or an attribute value
 *  goes through here, so publishing mode scrubs it whatever node it came from. */
function emit(text: string, ctx: RenderContext): string {
	return escapeHtml(scrubRuns([text], ctx)[0] ?? "");
}

/** True when a URL names the vault in any spelling a browser would still
 *  resolve to it: stray whitespace or controls, any case, percent-encoding. */
function namesVault(url: string, ctx: RenderContext): boolean {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping controls is the point
	let candidate = url.replace(/[\u0000- \u007f]/g, "");
	for (let pass = 0; pass <= MAX_DECODE_PASSES; pass += 1) {
		if (candidate.toLowerCase().includes(VAULT_SCHEME)) return true;
		if (ctx.sensitiveIds.some((id) => candidate.includes(id))) return true;
		let decoded: string;
		try {
			decoded = decodeURIComponent(candidate);
		} catch {
			return true;
		}
		if (decoded === candidate) return false;
		candidate = decoded;
	}
	return true;
}

/** A URL safe to emit, escaped — or `null` to drop the attribute entirely. */
function safeUrl(raw: string, ctx: RenderContext): string | null {
	const url = raw.trim();
	if (url === "" || !SAFE_URL_SCHEME.test(url)) return null;
	if (ctx.resolveEntityHref && namesVault(url, ctx)) return null;
	return escapeHtml(url);
}

function idAfterPrefix(url: string, prefix: string): string | null {
	if (!url.startsWith(prefix)) return null;
	const id = url.slice(prefix.length).split(/[/?#]/)[0] ?? "";
	return id.length > 0 ? id : null;
}

function linkHref(raw: string, ctx: RenderContext): string | null {
	const url = raw.trim();
	const entityId = ctx.resolveEntityHref ? idAfterPrefix(url, ENTITY_URL_PREFIX) : null;
	if (entityId && ctx.resolveEntityHref) {
		const href = ctx.resolveEntityHref(entityId);
		return href ? escapeHtml(href) : null;
	}
	return safeUrl(url, ctx);
}

/** The form of an image source the serializer decides on and emits. Anything
 *  that budgets or allow-lists image sources must key on this same string. */
export function normalizeImageSrc(raw: string): string {
	return raw.trim();
}

function imageSrc(raw: string, ctx: RenderContext): string | null {
	const url = normalizeImageSrc(raw);
	if (ctx.allowDataImages && DATA_IMAGE_URL.test(url)) {
		if (ctx.allowDataImages === true || ctx.allowDataImages(url)) return url;
		return null;
	}
	if (!ctx.resolveEntityHref) return safeUrl(url, ctx);
	// A published page loads nothing it does not carry: a remote image would
	// report every visitor to a third party.
	const assetId = idAfterPrefix(url, ASSET_URL_PREFIX);
	const src = assetId ? (ctx.resolveAssetSrc?.(assetId) ?? null) : null;
	return src ? escapeHtml(src) : null;
}

/** A mention / page reference / transclusion: a link to the target's page
 *  when it is published, its label otherwise — and in publishing mode the
 *  neutral stand-in, because the label is the unpublished target's title. */
function renderEntityReference(node: SerializedNode, ctx: RenderContext): string {
	const stored = str(node.label) || str(node.text);
	if (!ctx.resolveEntityHref) return emit(stored, ctx);
	const entityId = str(node.entityId);
	const href = entityId ? ctx.resolveEntityHref(entityId) : null;
	if (!href) return escapeHtml(standIn(ctx));
	const label = ctx.resolveEntityLabel?.(entityId) ?? stored;
	return `<a href="${escapeHtml(href)}">${emit(label, ctx)}</a>`;
}

function clampPercent(value: number): number {
	return Number.isFinite(value) ? Math.min(100, Math.max(10, Math.round(value))) : 100;
}

function formatText(text: string, node: SerializedNode): string {
	if (text === "") return "";
	const format = typeof node.format === "number" ? node.format : 0;
	let html = escapeHtml(text);
	if (format & TextFormat.Code) html = `<code>${html}</code>`;
	if (format & TextFormat.Strikethrough) html = `<s>${html}</s>`;
	if (format & TextFormat.Underline) html = `<u>${html}</u>`;
	if (format & TextFormat.Italic) html = `<em>${html}</em>`;
	if (format & TextFormat.Bold) html = `<strong>${html}</strong>`;
	return html;
}

function isTextNode(node: SerializedNode): boolean {
	const type = str(node.type);
	return type === "text" || type === "code-highlight";
}

/** A subtree's text in document order, without recursion. */
function flatText(node: SerializedNode): string {
	const parts: string[] = [];
	const pending: SerializedNode[] = [node];
	for (let next = pending.pop(); next; next = pending.pop()) {
		parts.push(str(next.text));
		const children = asNodes(next.children);
		for (let index = children.length - 1; index >= 0; index -= 1) {
			pending.push(children[index] as SerializedNode);
		}
	}
	return parts.join("");
}

function renderChildren(node: SerializedNode, ctx: RenderContext, depth: number): string {
	let html = "";
	let runs: SerializedNode[] = [];
	const flushRuns = () => {
		const texts = scrubRuns(
			runs.map((run) => str(run.text)),
			ctx,
		);
		runs.forEach((run, index) => {
			html += formatText(texts[index] ?? "", run);
		});
		runs = [];
	};
	for (const child of asNodes(node.children)) {
		if (isTextNode(child)) {
			runs.push(child);
			continue;
		}
		flushRuns();
		html += renderNode(child, ctx, depth + 1);
	}
	flushRuns();
	return html;
}

/** ` style="…"` for a block's stored background (B11.23), or "". */
function blockStyleAttr(node: SerializedNode): string {
	const css = blockBackgroundExportCss(node.style);
	return css ? ` style="${escapeHtml(css)}"` : "";
}

function renderNode(node: SerializedNode, ctx: RenderContext, depth: number): string {
	if (depth > MAX_RENDER_DEPTH) return emit(flatText(node), ctx);
	switch (str(node.type)) {
		case "paragraph":
			return `<p${blockStyleAttr(node)}>${renderChildren(node, ctx, depth)}</p>`;
		case "heading": {
			const tag = ["h1", "h2", "h3", "h4", "h5", "h6"].includes(str(node.tag)) ? str(node.tag) : "h2";
			return `<${tag}${blockStyleAttr(node)}>${renderChildren(node, ctx, depth)}</${tag}>`;
		}
		case "quote":
			return `<blockquote${blockStyleAttr(node)}>${renderChildren(node, ctx, depth)}</blockquote>`;
		case "list": {
			const tag = str(node.listType) === "number" ? "ol" : "ul";
			return `<${tag}>${renderChildren(node, ctx, depth)}</${tag}>`;
		}
		case "listitem":
			return `<li${blockStyleAttr(node)}>${renderChildren(node, ctx, depth)}</li>`;
		case "link":
		case "autolink": {
			const href = linkHref(str(node.url), ctx);
			const content = renderChildren(node, ctx, depth);
			if (!href && ctx.resolveEntityHref) return content;
			const open = href ? `<a href="${href}" rel="noreferrer">` : "<a>";
			return `${open}${content}</a>`;
		}
		case "code":
			return `<pre>${renderChildren(node, ctx, depth)}</pre>`;
		case "code-highlight":
		case "text":
			return formatText(scrubRuns([str(node.text)], ctx)[0] ?? "", node);
		case "linebreak":
			return "<br />";
		case "tab":
			return "\t";
		case "image": {
			const src = imageSrc(str(node.src), ctx);
			if (!src) return "";
			const caption = str(node.caption);
			const fig = `<img src="${src}" alt="${emit(str(node.altText), ctx)}" />`;
			return caption ? `<figure>${fig}<figcaption>${emit(caption, ctx)}</figcaption></figure>` : fig;
		}
		case "tabs":
			// No portable tab widget: every pane renders in order under its
			// title, so nothing hidden behind an inactive tab is lost.
			return `<div>${asNodes(node.children)
				.filter((pane) => str(pane.type) === "tab-pane")
				.map(
					(pane) =>
						`<section><h3>${emit(str(pane.title), ctx)}</h3>${renderChildren(pane, ctx, depth + 1)}</section>`,
				)
				.join("")}</div>`;
		case "image-block": {
			const src = imageSrc(str(node.src), ctx);
			if (!src) return "";
			const width = typeof node.widthPercent === "number" ? clampPercent(node.widthPercent) : 100;
			const style = width < 100 ? ` style="width:${width}%"` : "";
			const caption = str(node.caption);
			const fig = `<img src="${src}" alt="${emit(str(node.alt), ctx)}"${style} />`;
			return `<figure>${fig}${caption ? `<figcaption>${emit(caption, ctx)}</figcaption>` : ""}</figure>`;
		}
		case "bookmark":
		case "web-embed": {
			// An export never carries the iframe: it would make the exported
			// file fetch third-party content when opened.
			const href = safeExternalHref(str(node.url));
			if (!href || (ctx.resolveEntityHref && namesVault(href, ctx))) return "";
			const label = emit(str(node.title).trim() || href, ctx);
			return `<p><a href="${escapeHtml(href)}" rel="noreferrer">${label}</a></p>`;
		}
		case "inline-image": {
			const src = imageSrc(str(node.src), ctx);
			if (!src) return "";
			const height =
				typeof node.heightEm === "number" && Number.isFinite(node.heightEm)
					? Math.min(4, Math.max(0.75, node.heightEm))
					: 1.25;
			return `<img src="${src}" alt="${emit(str(node.alt), ctx)}" style="height:${height}em;vertical-align:text-bottom" />`;
		}
		case "title":
			return `<h1>${renderChildren(node, ctx, depth)}</h1>`;
		case "horizontalrule":
			return "<hr />";
		case "table":
			return `<table>${renderChildren(node, ctx, depth)}</table>`;
		case "tablerow":
			return `<tr>${renderChildren(node, ctx, depth)}</tr>`;
		case "tablecell": {
			const tag = typeof node.headerState === "number" && node.headerState > 0 ? "th" : "td";
			return `<${tag}>${renderChildren(node, ctx, depth)}</${tag}>`;
		}
		case "mention":
		case "page-ref":
		case "transclusion":
		case "inline-transclusion":
			return renderEntityReference(node, ctx);
		case "date-mention":
			return emit(str(node.label), ctx);
		default:
			// Containers we have no portable form for (callout, toggle, columns…)
			// still keep their content; leaf decorators (embeds, equations…)
			// render their plain text if any, else nothing.
			if (asNodes(node.children).length > 0) {
				return `<div>${renderChildren(node, ctx, depth)}</div>`;
			}
			return emit(str(node.text), ctx);
	}
}

/** Serialize an editor state's top-level blocks to a portable HTML string.
 *  Accepts the parsed state object or its JSON string; returns `""` for an
 *  empty / malformed state. `maxBlocks` truncates (snippet/export-preview). */
export function serializedStateToHtml(
	state: SerializedEditorStateLike | string | null | undefined,
	options: SerializeHtmlOptions = {},
): string {
	let parsed: SerializedEditorStateLike | null = null;
	if (typeof state === "string") {
		try {
			parsed = JSON.parse(state) as SerializedEditorStateLike;
		} catch {
			parsed = null;
		}
	} else {
		parsed = state ?? null;
	}
	const root = parsed?.root;
	if (!root) return "";
	let blocks = asNodes(root.children);
	if (typeof options.maxBlocks === "number") blocks = blocks.slice(0, options.maxBlocks);
	const ctx: RenderContext = {
		...options,
		sensitiveIds: options.resolveEntityHref ? collectSensitiveIds(root) : [],
	};
	return blocks.map((block) => renderNode(block, ctx, 0)).join("");
}
