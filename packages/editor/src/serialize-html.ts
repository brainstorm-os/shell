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
import { type SerializedEditorStateLike, type SerializedNode, TextFormat } from "./preview";

/** URL schemes safe to keep in an exported `href`/`src`. Anything else (incl.
 *  `javascript:`, `data:` for links, `vbscript:`) is dropped — the anchor
 *  renders without an href rather than carrying an executable URL. */
const SAFE_URL_SCHEME = /^(https?:|mailto:|tel:|brainstorm:|#|\/|\.)/i;
const VAULT_URL_SCHEME = /^brainstorm:/i;
const ENTITY_URL_PREFIX = "brainstorm://entity/";
const ASSET_URL_PREFIX = "brainstorm://asset/";
/** Raster only: an SVG `data:` image is a document that can carry script. */
const DATA_IMAGE_URL = /^data:image\/(png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=]+$/;

export type SerializeHtmlOptions = {
	maxBlocks?: number;
	/** Publishing mode (IE-12). Maps an entity id to the relative href of its
	 *  published page, or `null` when the entity is not published. When set, no
	 *  `brainstorm:` URL and no entity id can reach the output: a reference to
	 *  an unpublished entity keeps neither its link nor its stored label. */
	resolveEntityHref?: (entityId: string) => string | null;
	/** Maps a `brainstorm://asset/<id>` image to the relative path of its
	 *  copied file, or `null` to drop the image. */
	resolveAssetSrc?: (assetId: string) => string | null;
	/** Text standing in for a mention / page reference whose target is not
	 *  published. Its stored label is the target's title, so it is never used. */
	unpublishedLabel?: string;
	/** Keep inline raster `data:` images. */
	allowDataImages?: boolean;
};

type RenderContext = Pick<
	SerializeHtmlOptions,
	"resolveEntityHref" | "resolveAssetSrc" | "unpublishedLabel" | "allowDataImages"
>;

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

/** A URL safe to emit, escaped — or `null` to drop the attribute entirely. */
function safeUrl(raw: string, ctx: RenderContext): string | null {
	const url = raw.trim();
	if (url === "" || !SAFE_URL_SCHEME.test(url)) return null;
	if (ctx.resolveEntityHref && VAULT_URL_SCHEME.test(url)) return null;
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

function imageSrc(raw: string, ctx: RenderContext): string | null {
	const url = raw.trim();
	const assetId = ctx.resolveAssetSrc ? idAfterPrefix(url, ASSET_URL_PREFIX) : null;
	if (assetId && ctx.resolveAssetSrc) {
		const src = ctx.resolveAssetSrc(assetId);
		return src ? escapeHtml(src) : null;
	}
	if (ctx.allowDataImages && DATA_IMAGE_URL.test(url)) return url;
	return safeUrl(url, ctx);
}

/** A mention / page reference / transclusion: a link to the target's page
 *  when it is published, its label otherwise — and in publishing mode the
 *  neutral stand-in, because the label is the unpublished target's title. */
function renderEntityReference(node: SerializedNode, ctx: RenderContext): string {
	const label = escapeHtml(str(node.label) || str(node.text));
	if (!ctx.resolveEntityHref) return label;
	const entityId = str(node.entityId);
	const href = entityId ? ctx.resolveEntityHref(entityId) : null;
	if (!href) return escapeHtml(ctx.unpublishedLabel ?? "");
	return `<a href="${escapeHtml(href)}">${label}</a>`;
}

function clampPercent(value: number): number {
	return Number.isFinite(value) ? Math.min(100, Math.max(10, Math.round(value))) : 100;
}

/** A vault URL typed (or auto-linked) as visible text carries the id as surely
 *  as an href does. */
const VAULT_URL_IN_TEXT = /brainstorm:\/\/[^\s<>"')\]]*/gi;

function renderText(node: SerializedNode, ctx: RenderContext): string {
	const raw = str(node.text);
	const text = ctx.resolveEntityHref
		? raw.replace(VAULT_URL_IN_TEXT, ctx.unpublishedLabel ?? "")
		: raw;
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

function renderChildren(node: SerializedNode, ctx: RenderContext): string {
	return asNodes(node.children)
		.map((child) => renderNode(child, ctx))
		.join("");
}

/** ` style="…"` for a block's stored background (B11.23), or "". */
function blockStyleAttr(node: SerializedNode): string {
	const css = blockBackgroundExportCss(node.style);
	return css ? ` style="${escapeHtml(css)}"` : "";
}

function renderNode(node: SerializedNode, ctx: RenderContext): string {
	switch (str(node.type)) {
		case "paragraph":
			return `<p${blockStyleAttr(node)}>${renderChildren(node, ctx)}</p>`;
		case "heading": {
			const tag = ["h1", "h2", "h3", "h4", "h5", "h6"].includes(str(node.tag)) ? str(node.tag) : "h2";
			return `<${tag}${blockStyleAttr(node)}>${renderChildren(node, ctx)}</${tag}>`;
		}
		case "quote":
			return `<blockquote${blockStyleAttr(node)}>${renderChildren(node, ctx)}</blockquote>`;
		case "list": {
			const tag = str(node.listType) === "number" ? "ol" : "ul";
			return `<${tag}>${renderChildren(node, ctx)}</${tag}>`;
		}
		case "listitem":
			return `<li${blockStyleAttr(node)}>${renderChildren(node, ctx)}</li>`;
		case "link":
		case "autolink": {
			const href = linkHref(str(node.url), ctx);
			if (!href && ctx.resolveEntityHref) return renderChildren(node, ctx);
			const open = href ? `<a href="${href}" rel="noreferrer">` : "<a>";
			return `${open}${renderChildren(node, ctx)}</a>`;
		}
		case "code":
			return `<pre>${renderChildren(node, ctx)}</pre>`;
		case "code-highlight":
		case "text":
			return renderText(node, ctx);
		case "linebreak":
			return "<br />";
		case "tab":
			return "\t";
		case "image": {
			const src = imageSrc(str(node.src), ctx);
			const alt = escapeHtml(str(node.altText));
			if (!src) return "";
			const caption = str(node.caption);
			const fig = `<img src="${src}" alt="${alt}" />`;
			return caption ? `<figure>${fig}<figcaption>${escapeHtml(caption)}</figcaption></figure>` : fig;
		}
		case "tabs":
			// No portable tab widget: every pane renders in order under its
			// title, so nothing hidden behind an inactive tab is lost.
			return `<div>${asNodes(node.children)
				.filter((pane) => str(pane.type) === "tab-pane")
				.map(
					(pane) =>
						`<section><h3>${escapeHtml(str(pane.title))}</h3>${renderChildren(pane, ctx)}</section>`,
				)
				.join("")}</div>`;
		case "image-block": {
			const src = imageSrc(str(node.src), ctx);
			if (!src) return "";
			const alt = escapeHtml(str(node.alt));
			const width = typeof node.widthPercent === "number" ? clampPercent(node.widthPercent) : 100;
			const style = width < 100 ? ` style="width:${width}%"` : "";
			const caption = str(node.caption);
			const fig = `<img src="${src}" alt="${alt}"${style} />`;
			return `<figure>${fig}${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ""}</figure>`;
		}
		case "inline-image": {
			const src = imageSrc(str(node.src), ctx);
			if (!src) return "";
			const height =
				typeof node.heightEm === "number" && Number.isFinite(node.heightEm)
					? Math.min(4, Math.max(0.75, node.heightEm))
					: 1.25;
			return `<img src="${src}" alt="${escapeHtml(str(node.alt))}" style="height:${height}em;vertical-align:text-bottom" />`;
		}
		case "title":
			return `<h1>${renderChildren(node, ctx)}</h1>`;
		case "horizontalrule":
			return "<hr />";
		case "table":
			return `<table>${renderChildren(node, ctx)}</table>`;
		case "tablerow":
			return `<tr>${renderChildren(node, ctx)}</tr>`;
		case "tablecell": {
			const tag = typeof node.headerState === "number" && node.headerState > 0 ? "th" : "td";
			return `<${tag}>${renderChildren(node, ctx)}</${tag}>`;
		}
		case "mention":
		case "page-ref":
		case "transclusion":
		case "inline-transclusion":
			return renderEntityReference(node, ctx);
		case "date-mention":
			return escapeHtml(str(node.label));
		default:
			// Containers we have no portable form for (callout, toggle, columns…)
			// still keep their content; leaf decorators (embeds, equations…)
			// render their plain text if any, else nothing.
			if (asNodes(node.children).length > 0) return `<div>${renderChildren(node, ctx)}</div>`;
			return escapeHtml(str(node.text));
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
	return blocks.map((block) => renderNode(block, options)).join("");
}
