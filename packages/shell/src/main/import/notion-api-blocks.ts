/**
 * IE-7 rung 1 — Notion **API** block JSON → importer markdown.
 *
 * The one-shot Notion-API Source (OQ-243 → (a): a non-file Source in the
 * IE-2 pipeline that reuses the connector OAuth broker but keeps no cursor)
 * feeds the SAME parse→map→write tail as the IE-6 export-zip importer. The
 * cleanest reuse is to render each API page's block tree into the exact
 * markdown dialect `plant-import-body.markdownToSerializedState` already
 * parses — then the existing planting path handles the rest, no second body
 * codec.
 *
 * This module is that renderer: pure, transport-free (no API client, no
 * OAuth here — the client that pages the API lands in a later rung), so the
 * conversion is unit-tested against fixtures without credentials.
 *
 * The Notion API's `rich_text`/`block` shapes differ entirely from the
 * markdown export IE-6 reads (JSON block trees vs `.md` files), so this
 * conversion is genuinely new; only the downstream Map/Write is shared.
 *
 * Fidelity note: `markdownToSerializedState` is single-pass (first-match
 * inline, no nested marks) and has no strikethrough/underline/callout
 * syntax. So each inline segment renders its STRONGEST single mark
 * (link > code > bold > italic) and blocks the dialect can't express
 * (callout, toggle) flatten to a paragraph/quote — the same lossy posture
 * Notion's own markdown export takes, so nothing is silently dropped.
 */

/** A Notion API `rich_text` element (the fields we read). */
export type NotionRichText = {
	readonly plain_text: string;
	readonly href?: string | null;
	readonly annotations?: {
		readonly bold?: boolean;
		readonly italic?: boolean;
		readonly code?: boolean;
		readonly strikethrough?: boolean;
		readonly underline?: boolean;
	};
};

/** A Notion API block. The type-specific payload is keyed by `type`
 *  (`block.paragraph`, `block.heading_1`, …), so it's an open record. */
export type NotionBlock = {
	readonly type: string;
	readonly has_children?: boolean;
	readonly children?: readonly NotionBlock[];
	readonly [key: string]: unknown;
};

/** Render a `rich_text` array to inline markdown. Each segment gets its
 *  strongest single mark, in the priority the single-pass importer can
 *  actually parse without leaving literal markers. */
export function notionRichTextToMarkdown(rich: readonly NotionRichText[] | undefined): string {
	if (!rich || rich.length === 0) return "";
	let out = "";
	for (const seg of rich) {
		const text = seg.plain_text ?? "";
		if (text.length === 0) continue;
		const a = seg.annotations;
		if (seg.href) {
			out += `[${text}](${seg.href})`;
		} else if (a?.code) {
			out += `\`${text}\``;
		} else if (a?.bold) {
			out += `**${text}**`;
		} else if (a?.italic) {
			out += `*${text}*`;
		} else {
			out += text;
		}
	}
	return out;
}

/** Read the `rich_text` off a block's type-specific payload. */
function blockRichText(block: NotionBlock): readonly NotionRichText[] {
	const payload = block[block.type] as { rich_text?: readonly NotionRichText[] } | undefined;
	return payload?.rich_text ?? [];
}

/** The url of an image/file block (external or Notion-hosted `file`). */
function fileUrl(payload: unknown): string {
	const p = payload as { external?: { url?: string }; file?: { url?: string } } | undefined;
	return p?.external?.url ?? p?.file?.url ?? "";
}

/**
 * Render a single block to markdown line(s). `null` when the block yields
 * nothing (an unknown/empty block). Children are NOT recursed here — the
 * caller (`notionBlocksToMarkdown`) owns tree traversal so it can control
 * block spacing.
 */
export function notionBlockToMarkdown(block: NotionBlock): string | null {
	const inline = () => notionRichTextToMarkdown(blockRichText(block));
	switch (block.type) {
		case "paragraph":
			return inline();
		case "heading_1":
			return `# ${inline()}`;
		case "heading_2":
			return `## ${inline()}`;
		case "heading_3":
			return `### ${inline()}`;
		case "bulleted_list_item":
			return `- ${inline()}`;
		case "numbered_list_item":
			return `1. ${inline()}`;
		case "to_do": {
			const done = (block.to_do as { checked?: boolean } | undefined)?.checked === true;
			return `- [${done ? "x" : " "}] ${inline()}`;
		}
		case "quote":
			return `> ${inline()}`;
		case "toggle":
			// No toggle syntax in the dialect — flatten to a paragraph (its
			// summary text); children still recurse after it.
			return inline();
		case "callout": {
			// No callout syntax either — flatten to a quote, prefixing the icon
			// emoji when present so the cue isn't lost.
			const icon = (block.callout as { icon?: { emoji?: string } } | undefined)?.icon?.emoji;
			const text = inline();
			return `> ${icon ? `${icon} ` : ""}${text}`;
		}
		case "code": {
			const payload = block.code as { language?: string } | undefined;
			const lang = normalizeCodeLang(payload?.language);
			return `\`\`\`${lang}\n${plainText(blockRichText(block))}\n\`\`\``;
		}
		case "divider":
			return "---";
		case "image": {
			const payload = block.image as { caption?: readonly NotionRichText[] } | undefined;
			const alt = notionRichTextToMarkdown(payload?.caption) || "image";
			const url = fileUrl(block.image);
			return url ? `![${alt}](${url})` : null;
		}
		default:
			// Unknown block: emit its text if it carries any, else drop it.
			return blockRichText(block).length > 0 ? inline() : null;
	}
}

/** Concatenate `rich_text` to raw text (for code blocks — no inline marks). */
function plainText(rich: readonly NotionRichText[]): string {
	return rich.map((r) => r.plain_text ?? "").join("");
}

/** Notion's `plain text` code language → a fence label the editor accepts;
 *  Notion's own value is already a lowercase token for most languages. */
function normalizeCodeLang(lang: string | undefined): string {
	if (!lang || lang === "plain text") return "";
	return lang;
}

/**
 * Render a Notion block tree to importer markdown. Blocks are separated by
 * a blank line (paragraph semantics); consecutive list items are NOT
 * blank-separated so the dialect groups them into one list. Children of a
 * block are appended after it (flattened — the dialect has no nested-list
 * indent), which keeps toggle/column content in reading order.
 */
export function notionBlocksToMarkdown(blocks: readonly NotionBlock[]): string {
	const lines: string[] = [];
	const walk = (list: readonly NotionBlock[]): void => {
		let prevWasListItem = false;
		for (const block of list) {
			const md = notionBlockToMarkdown(block);
			const isListItem =
				block.type === "bulleted_list_item" ||
				block.type === "numbered_list_item" ||
				block.type === "to_do";
			if (md !== null) {
				// Blank line between blocks, except between adjacent list items.
				if (lines.length > 0 && !(isListItem && prevWasListItem)) lines.push("");
				lines.push(md);
				prevWasListItem = isListItem;
			}
			if (block.children && block.children.length > 0) {
				walk(block.children);
				prevWasListItem = false;
			}
		}
	};
	walk(blocks);
	return lines.join("\n");
}
