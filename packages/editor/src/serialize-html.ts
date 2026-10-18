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
function safeUrl(raw: string): string | null {
	const url = raw.trim();
	if (url === "" || !SAFE_URL_SCHEME.test(url)) return null;
	return escapeHtml(url);
}

function clampPercent(value: number): number {
	return Number.isFinite(value) ? Math.min(100, Math.max(10, Math.round(value))) : 100;
}

function renderText(node: SerializedNode): string {
	const text = str(node.text);
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

function renderChildren(node: SerializedNode): string {
	return asNodes(node.children).map(renderNode).join("");
}

/** ` style="…"` for a block's stored background (B11.23), or "". */
function blockStyleAttr(node: SerializedNode): string {
	const css = blockBackgroundExportCss(node.style);
	return css ? ` style="${escapeHtml(css)}"` : "";
}

function renderNode(node: SerializedNode): string {
	switch (str(node.type)) {
		case "paragraph":
			return `<p${blockStyleAttr(node)}>${renderChildren(node)}</p>`;
		case "heading": {
			const tag = ["h1", "h2", "h3", "h4", "h5", "h6"].includes(str(node.tag)) ? str(node.tag) : "h2";
			return `<${tag}${blockStyleAttr(node)}>${renderChildren(node)}</${tag}>`;
		}
		case "quote":
			return `<blockquote${blockStyleAttr(node)}>${renderChildren(node)}</blockquote>`;
		case "list": {
			const tag = str(node.listType) === "number" ? "ol" : "ul";
			return `<${tag}>${renderChildren(node)}</${tag}>`;
		}
		case "listitem":
			return `<li${blockStyleAttr(node)}>${renderChildren(node)}</li>`;
		case "link":
		case "autolink": {
			const href = safeUrl(str(node.url));
			const open = href ? `<a href="${href}" rel="noreferrer">` : "<a>";
			return `${open}${renderChildren(node)}</a>`;
		}
		case "code":
			return `<pre>${renderChildren(node)}</pre>`;
		case "code-highlight":
		case "text":
			return renderText(node);
		case "linebreak":
			return "<br />";
		case "tab":
			return "\t";
		case "image": {
			const src = safeUrl(str(node.src));
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
					(pane) => `<section><h3>${escapeHtml(str(pane.title))}</h3>${renderChildren(pane)}</section>`,
				)
				.join("")}</div>`;
		case "image-block": {
			const src = safeUrl(str(node.src));
			if (!src) return "";
			const alt = escapeHtml(str(node.alt));
			const width = typeof node.widthPercent === "number" ? clampPercent(node.widthPercent) : 100;
			const style = width < 100 ? ` style="width:${width}%"` : "";
			const caption = str(node.caption);
			const fig = `<img src="${src}" alt="${alt}"${style} />`;
			return `<figure>${fig}${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ""}</figure>`;
		}
		case "inline-image": {
			const src = safeUrl(str(node.src));
			if (!src) return "";
			const height =
				typeof node.heightEm === "number" && Number.isFinite(node.heightEm)
					? Math.min(4, Math.max(0.75, node.heightEm))
					: 1.25;
			return `<img src="${src}" alt="${escapeHtml(str(node.alt))}" style="height:${height}em;vertical-align:text-bottom" />`;
		}
		default:
			// Unknown / decorator nodes (mentions, embeds, equations…) have no
			// portable HTML form in v1 — render their plain text if any, else skip.
			return escapeHtml(str(node.text));
	}
}

/** Serialize an editor state's top-level blocks to a portable HTML string.
 *  Accepts the parsed state object or its JSON string; returns `""` for an
 *  empty / malformed state. `maxBlocks` truncates (snippet/export-preview). */
export function serializedStateToHtml(
	state: SerializedEditorStateLike | string | null | undefined,
	options: { maxBlocks?: number } = {},
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
	return blocks.map(renderNode).join("");
}
