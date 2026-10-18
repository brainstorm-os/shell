/**
 * `serializedStateToMarkdown` — B11.12 export: a `SerializedEditorState` → a
 * Markdown string, for export-to-`.md`. Parallel to `serialize-html`
 * (`serializedStateToHtml`): a pure, tolerant walk over the serialized tree
 * (unknown / decorator nodes degrade to their plain text), no Lexical / DOM.
 *
 * This is the one-way **export** half. Markdown *import* (and the typing
 * round-trip) stays with `@lexical/markdown`'s transformers in the live
 * editor, which is where custom-node fidelity lives; an export-to-file only
 * needs a faithful textual rendering, not a re-importable AST.
 *
 * The trivial `str`/`asNodes` readers mirror `serialize-html`'s (3-line
 * shape-guards, below the extract-a-helper threshold); the substantive walk
 * differs per format (line-prefix + inline markers vs nested tags), so the two
 * serializers stay parallel rather than sharing a contrived visitor.
 */

import { type SerializedEditorStateLike, type SerializedNode, TextFormat } from "./preview";

function str(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function asNodes(value: unknown): SerializedNode[] {
	return Array.isArray(value) ? (value as SerializedNode[]) : [];
}

/** Inline content of a block: concatenated text runs with their Markdown
 *  emphasis markers + `[text](url)` links. Underline has no Markdown form, so
 *  it renders as plain text. */
function renderInline(nodes: SerializedNode[]): string {
	return nodes
		.map((node) => {
			const type = str(node.type);
			if (type === "link" || type === "autolink") {
				const label = renderInline(asNodes(node.children));
				const url = str(node.url);
				return url ? `[${label}](${url})` : label;
			}
			if (type === "linebreak") return "  \n"; // Markdown hard break
			if (type === "inline-image") {
				const src = str(node.src);
				return src ? `![${str(node.alt)}](${src})` : str(node.alt);
			}
			if (type === "text" || type === "code-highlight") {
				const text = str(node.text);
				if (text === "") return "";
				const format = typeof node.format === "number" ? node.format : 0;
				let out = text;
				if (format & TextFormat.Code) out = `\`${out}\``;
				if (format & TextFormat.Strikethrough) out = `~~${out}~~`;
				if (format & TextFormat.Italic) out = `*${out}*`;
				if (format & TextFormat.Bold) out = `**${out}**`;
				return out;
			}
			// Nested element (e.g. a child holding inline runs) or a decorator
			// node — recurse for its inline content, else fall back to its text.
			const children = asNodes(node.children);
			return children.length > 0 ? renderInline(children) : str(node.text);
		})
		.join("");
}

/** A list's items as Markdown rows (`- ` / `1. `), one per `listitem`. */
function renderList(node: SerializedNode): string {
	const ordered = str(node.listType) === "number";
	let n = 0;
	return asNodes(node.children)
		.filter((c) => str(c.type) === "listitem")
		.map((item) => {
			n += 1;
			const marker = ordered ? `${n}. ` : "- ";
			return `${marker}${renderInline(asNodes(item.children))}`;
		})
		.join("\n");
}

/** One top-level block → its Markdown, sans the trailing blank line (the
 *  caller joins blocks with `\n\n`). */
function renderBlock(node: SerializedNode): string {
	switch (str(node.type)) {
		case "heading": {
			const tag = str(node.tag);
			const level = /^h[1-6]$/.test(tag) ? Number(tag.slice(1)) : 2;
			return `${"#".repeat(level)} ${renderInline(asNodes(node.children))}`;
		}
		case "quote":
			return `> ${renderInline(asNodes(node.children))}`;
		case "list":
			return renderList(node);
		case "code": {
			const lang = str(node.language);
			return `\`\`\`${lang}\n${renderInline(asNodes(node.children))}\n\`\`\``;
		}
		case "image": {
			const src = str(node.src);
			return src ? `![${str(node.altText)}](${src})` : "";
		}
		case "tabs":
			return asNodes(node.children)
				.filter((pane) => str(pane.type) === "tab-pane")
				.map((pane) =>
					[`### ${str(pane.title)}`, ...asNodes(pane.children).map(renderBlock)]
						.filter((b) => b !== "")
						.join("\n\n"),
				)
				.join("\n\n");
		case "image-block": {
			const src = str(node.src);
			if (!src) return "";
			const caption = str(node.caption);
			return `![${str(node.alt)}](${src})${caption ? `\n\n*${caption}*` : ""}`;
		}
		case "horizontalrule":
			return "---";
		case "paragraph":
			return renderInline(asNodes(node.children));
		default:
			// Unknown / decorator block — its plain text, or recurse for inline.
			return renderInline([node]);
	}
}

/** Serialize an editor state's top-level blocks to a Markdown string. Accepts
 *  the parsed state or its JSON; `""` for empty/malformed. Blocks are joined
 *  by a blank line; `maxBlocks` truncates. */
export function serializedStateToMarkdown(
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
	return blocks
		.map(renderBlock)
		.filter((b) => b !== "")
		.join("\n\n");
}
