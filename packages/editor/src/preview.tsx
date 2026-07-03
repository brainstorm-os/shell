/**
 * Read-only preview renderer.
 *
 * Per §read-only renderer: search-result
 * previews, launcher snippets and graph labels must render rich text
 * **without instantiating Lexical** (a much heavier dependency than a read
 * path needs). This is a pure recursive walk of the serialized state →
 * React. Baseline nodes render natively; any non-baseline (custom / app)
 * node renders as a fallback chip bearing its type as the display hint
 * (the per-app custom-node registry that replaces the chip is a separate
 * registry per OQ-12, wired at Stage 9.4 via `BlockEmbedNode`).
 *
 * Input is the stable serialized wire format (`SerializedEditorState`),
 * which is what apps persist and what `@lexical/yjs` round-trips — so the
 * preview and the editor never disagree about a baseline node's shape.
 */

import { type CSSProperties, type ReactNode, createElement as h } from "react";

/** Lexical text-format bitmask (lexical/src/nodes/LexicalTextNode). */
export const TextFormat = {
	Bold: 1,
	Italic: 2,
	Strikethrough: 4,
	Underline: 8,
	Code: 16,
} as const;

export type SerializedNode = {
	type?: unknown;
	children?: unknown;
	[k: string]: unknown;
};

export type SerializedEditorStateLike = {
	root?: SerializedNode;
};

export type EditorPreviewOptions = {
	/** Hard cap on rendered top-level blocks (snippet contexts). */
	maxBlocks?: number;
};

function asNodes(value: unknown): SerializedNode[] {
	return Array.isArray(value) ? (value as SerializedNode[]) : [];
}

function str(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function renderText(node: SerializedNode, key: string): ReactNode {
	const text = str(node.text);
	if (text === "") return null;
	const format = typeof node.format === "number" ? node.format : 0;
	let el: ReactNode = text;
	if (format & TextFormat.Code) el = h("code", { className: "bs-editor__text--code" }, el);
	if (format & TextFormat.Strikethrough) el = h("s", null, el);
	if (format & TextFormat.Underline) el = h("u", null, el);
	if (format & TextFormat.Italic) el = h("em", null, el);
	if (format & TextFormat.Bold) el = h("strong", null, el);
	return h("span", { key }, el);
}

function renderChildren(node: SerializedNode): ReactNode[] {
	return asNodes(node.children)
		.map((child, i) => renderNode(child, String(i)))
		.filter((n): n is ReactNode => n !== null);
}

function fallbackChip(node: SerializedNode, key: string): ReactNode {
	const hint = str(node.type, "unknown");
	return h(
		"span",
		{ key, className: "bs-editor__unknown", "data-node-type": hint, title: hint },
		`⟦${hint}⟧`,
	);
}

function renderNode(node: SerializedNode, key: string): ReactNode {
	switch (str(node.type)) {
		case "paragraph":
			return h("p", { key, className: "bs-editor__paragraph" }, ...renderChildren(node));
		case "heading": {
			const tag = ["h1", "h2", "h3", "h4", "h5", "h6"].includes(str(node.tag)) ? str(node.tag) : "h2";
			return h(tag, { key, className: `bs-editor__${tag}` }, ...renderChildren(node));
		}
		case "quote":
			return h("blockquote", { key, className: "bs-editor__quote" }, ...renderChildren(node));
		case "list": {
			const listType = str(node.listType);
			const ordered = listType === "number";
			const variant = listType === "check" ? "check" : ordered ? "numbered" : "bullet";
			return h(
				ordered ? "ol" : "ul",
				{ key, className: `bs-editor__list bs-editor__list--${variant}` },
				...renderChildren(node),
			);
		}
		case "listitem": {
			// A check-list item carries a boolean `checked`; render the same
			// checked/unchecked classes the live editor theme emits so a sent
			// message shows the (non-interactive) checkbox state.
			const checked = typeof node.checked === "boolean" ? node.checked : null;
			const className =
				checked === null
					? "bs-editor__list-item"
					: `bs-editor__list-item bs-editor__list-item--${checked ? "checked" : "unchecked"}`;
			return h("li", { key, className }, ...renderChildren(node));
		}
		case "link":
		case "autolink":
			return h(
				"a",
				{ key, className: "bs-editor__link", href: str(node.url), rel: "noreferrer" },
				...renderChildren(node),
			);
		case "code":
			return h("pre", { key, className: "bs-editor__code" }, ...renderChildren(node));
		case "code-highlight":
		case "text":
			return renderText(node, key);
		case "linebreak":
			return h("br", { key });
		case "mention": {
			// Same chip family (and classes) as `MentionNode.decorate()` so a
			// mention reads identically in the live editor and a read-only body.
			const label = str(node.label) || str(node.entityId);
			return h(
				"span",
				{
					key,
					className: "notes__mention-chip",
					"data-entity-id": str(node.entityId),
					"data-entity-type": str(node.entityType),
				},
				h("span", { className: "notes__mention-at", "aria-hidden": "true" }, "@"),
				h("span", { className: "notes__mention-label" }, label),
			);
		}
		case "tab":
			return h("span", { key }, "\t");
		case "image": {
			const style: CSSProperties | undefined =
				typeof node.width === "number" ? { width: `${node.width}px` } : undefined;
			return h(
				"figure",
				{ key, className: "bs-editor__image" },
				h("img", { src: str(node.src), alt: str(node.altText), style }),
				str(node.caption)
					? h("figcaption", { className: "bs-editor__image-caption" }, str(node.caption))
					: null,
			);
		}
		default:
			return fallbackChip(node, key);
	}
}

/** Render the serialized state's top-level blocks to React (no Lexical). */
export function renderEditorState(
	state: SerializedEditorStateLike | string | null | undefined,
	options: EditorPreviewOptions = {},
): ReactNode[] {
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
	if (!root) return [];
	let blocks = asNodes(root.children);
	if (typeof options.maxBlocks === "number") blocks = blocks.slice(0, options.maxBlocks);
	return blocks
		.map((node, i) => renderNode(node, String(i)))
		.filter((n): n is ReactNode => n !== null);
}

export type EditorPreviewProps = EditorPreviewOptions & {
	state: SerializedEditorStateLike | string | null | undefined;
	className?: string;
};

export function EditorPreview({
	state,
	className = "bs-editor bs-editor--readonly",
	maxBlocks,
}: EditorPreviewProps): ReactNode {
	return h(
		"div",
		{ className },
		...renderEditorState(state, maxBlocks === undefined ? {} : { maxBlocks }),
	);
}
