/**
 * Small, safe markdown renderer shared across apps. The **block parser** is the
 * canonical home for the subset Brainstorm renders (Preview imports it; the
 * Agent renders model replies with the React view below) — extracted here at
 * copy two per the SDK catalog rule.
 *
 * Why hand-rolled: no external markdown lib (size budget) and inline strings +
 * `innerHTML` are an XSS class we don't carry into the sandbox. Every
 * user/model-supplied string becomes a text node / React text child, never an
 * HTML fragment — XSS-safe by construction.
 *
 * Subset:
 *   - Headings `#`–`####` · paragraphs (blank-line separated) · fenced code
 *   - Bullet (`-`/`*`) + ordered (`1.`) lists · `---` rule
 *   - Inline: `code`, **bold**, *italic*, [text](url)
 *
 * Out of scope (would need a real parser): nested lists, blockquotes, tables,
 * autolinks, reference links, images, footnotes, setext headings, raw HTML.
 */

import { Fragment, type ReactElement, type ReactNode, createElement } from "react";

/** Safe URL schemes for `[text](url)`. Everything else is not a web link —
 *  it renders as plain text unless an entity-link resolver claims it. */
const SAFE_LINK_PREFIXES: ReadonlyArray<string> = ["http://", "https://", "mailto:", "brainstorm:"];

/** Top-level block kinds the parser emits. */
export enum BlockKind {
	Heading = "heading",
	Paragraph = "paragraph",
	CodeFence = "code-fence",
	BulletList = "bullet-list",
	OrderedList = "ordered-list",
	HorizontalRule = "horizontal-rule",
}

export type MarkdownBlock =
	| { kind: BlockKind.Heading; level: 1 | 2 | 3 | 4; text: string }
	| { kind: BlockKind.Paragraph; text: string }
	| { kind: BlockKind.CodeFence; language: string | null; code: string }
	| { kind: BlockKind.BulletList; items: ReadonlyArray<string> }
	| { kind: BlockKind.OrderedList; items: ReadonlyArray<string> }
	| { kind: BlockKind.HorizontalRule };

/** Parse a markdown document into a flat block list. Pure — no DOM access. */
export function parseMarkdown(source: string): ReadonlyArray<MarkdownBlock> {
	const lines = source.replace(/\r\n?/g, "\n").split("\n");
	const blocks: MarkdownBlock[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i] ?? "";

		if (line.trim() === "") {
			i++;
			continue;
		}

		// Fenced code block
		const fence = line.match(/^```(\w*)\s*$/);
		if (fence) {
			const lang = fence[1] ?? "";
			const language = lang.trim() || null;
			i++;
			const start = i;
			while (i < lines.length && !/^```\s*$/.test(lines[i] ?? "")) {
				i++;
			}
			const code = lines.slice(start, i).join("\n");
			if (i < lines.length) i++; // consume closing fence
			blocks.push({ kind: BlockKind.CodeFence, language, code });
			continue;
		}

		// Horizontal rule
		if (/^---+\s*$/.test(line)) {
			blocks.push({ kind: BlockKind.HorizontalRule });
			i++;
			continue;
		}

		// Heading
		const heading = line.match(/^(#{1,4})\s+(.+?)\s*#*\s*$/);
		if (heading) {
			const hashes = heading[1] ?? "";
			const level = clampHeadingLevel(hashes.length);
			blocks.push({ kind: BlockKind.Heading, level, text: heading[2] ?? "" });
			i++;
			continue;
		}

		// Bullet list
		if (/^[-*]\s+/.test(line)) {
			const items: string[] = [];
			while (i < lines.length && /^[-*]\s+/.test(lines[i] ?? "")) {
				items.push((lines[i] ?? "").replace(/^[-*]\s+/, ""));
				i++;
			}
			blocks.push({ kind: BlockKind.BulletList, items });
			continue;
		}

		// Ordered list
		if (/^\d+\.\s+/.test(line)) {
			const items: string[] = [];
			while (i < lines.length && /^\d+\.\s+/.test(lines[i] ?? "")) {
				items.push((lines[i] ?? "").replace(/^\d+\.\s+/, ""));
				i++;
			}
			blocks.push({ kind: BlockKind.OrderedList, items });
			continue;
		}

		// Paragraph — slurp non-blank, non-heading, non-fence, non-list lines.
		const para: string[] = [line];
		i++;
		while (i < lines.length) {
			const next = lines[i] ?? "";
			if (next.trim() === "") break;
			if (/^#{1,4}\s+/.test(next)) break;
			if (/^```/.test(next)) break;
			if (/^[-*]\s+/.test(next)) break;
			if (/^\d+\.\s+/.test(next)) break;
			if (/^---+\s*$/.test(next)) break;
			para.push(next);
			i++;
		}
		blocks.push({ kind: BlockKind.Paragraph, text: para.join(" ") });
	}

	return blocks;
}

export function isSafeLinkUrl(raw: string): boolean {
	const url = raw.trim().toLowerCase();
	for (const prefix of SAFE_LINK_PREFIXES) {
		if (url.startsWith(prefix)) return true;
	}
	return false;
}

/** Quick word count over the parsed-block text content. */
export function wordCountForMarkdown(source: string): number {
	const blocks = parseMarkdown(source);
	let words = 0;
	for (const block of blocks) {
		if (block.kind === BlockKind.Heading || block.kind === BlockKind.Paragraph) {
			words += countWords(block.text);
		} else if (block.kind === BlockKind.BulletList || block.kind === BlockKind.OrderedList) {
			for (const item of block.items) words += countWords(item);
		}
		// code fences + rules don't count toward word totals.
	}
	return words;
}

function countWords(text: string): number {
	const trimmed = text.trim();
	if (!trimmed) return 0;
	return trimmed.split(/\s+/).length;
}

function clampHeadingLevel(n: number): 1 | 2 | 3 | 4 {
	if (n <= 1) return 1;
	if (n === 2) return 2;
	if (n === 3) return 3;
	return 4;
}

// ─── React view ──────────────────────────────────────────────────────────────

/** Resolve a non-web link target (e.g. a bare entity id from the Agent's
 *  `[label](id)` citation protocol) to a click handler. Return null to render
 *  the link as plain text (the safe default). */
export type EntityLinkResolver = (target: string) => (() => void) | null;

export interface MarkdownProps {
	/** The markdown source (a model reply, a note body, …). */
	source: string;
	/** Extra layout class on the root (never re-skin the prose). */
	className?: string;
	/** Optional resolver for non-web `[text](target)` links — used by the Agent
	 *  to make `[label](entity-id)` citations open the object. */
	onEntityLink?: EntityLinkResolver;
}

/** Render a markdown string as a `.bs-markdown` prose block. Load styles once
 *  per app: `import "@brainstorm/sdk/markdown.css"`. */
export function Markdown({ source, className, onEntityLink }: MarkdownProps): ReactElement {
	const blocks = parseMarkdown(source);
	const cls = className ? `bs-markdown ${className}` : "bs-markdown";
	return (
		<div className={cls}>{blocks.map((block, idx) => renderBlock(block, idx, onEntityLink))}</div>
	);
}

function renderBlock(
	block: MarkdownBlock,
	key: number,
	onEntityLink?: EntityLinkResolver,
): ReactNode {
	switch (block.kind) {
		case BlockKind.Heading:
			return createElement(
				`h${block.level}`,
				{ key, className: "bs-markdown__heading" },
				renderInline(block.text, onEntityLink),
			);
		case BlockKind.Paragraph:
			return (
				<p key={key} className="bs-markdown__paragraph">
					{renderInline(block.text, onEntityLink)}
				</p>
			);
		case BlockKind.CodeFence:
			return (
				<pre key={key} className="bs-markdown__code">
					<code {...(block.language ? { "data-language": block.language } : {})}>{block.code}</code>
				</pre>
			);
		case BlockKind.BulletList:
			return (
				<ul key={key} className="bs-markdown__list">
					{block.items.map((item, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: static parsed list, never reordered.
						<li key={i}>{renderInline(item, onEntityLink)}</li>
					))}
				</ul>
			);
		case BlockKind.OrderedList:
			return (
				<ol key={key} className="bs-markdown__list">
					{block.items.map((item, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: static parsed list, never reordered.
						<li key={i}>{renderInline(item, onEntityLink)}</li>
					))}
				</ol>
			);
		case BlockKind.HorizontalRule:
			return <hr key={key} className="bs-markdown__rule" />;
	}
}

// Pathological `***...***` nests recurse one level per emphasis pair; 32 covers
// any plausible doc and blocks deeply hostile inputs.
const MAX_INLINE_DEPTH = 32;

/** Walk inline markers (code / bold / italic / link) into React nodes. */
function renderInline(source: string, onEntityLink?: EntityLinkResolver, depth = 0): ReactNode[] {
	if (depth > MAX_INLINE_DEPTH) return [source];
	const out: ReactNode[] = [];
	let i = 0;
	let buffer = "";
	let key = 0;
	const flush = (): void => {
		if (buffer) {
			out.push(<Fragment key={`t${key++}`}>{buffer}</Fragment>);
			buffer = "";
		}
	};

	while (i < source.length) {
		const ch = source[i];

		// Inline code: `…`
		if (ch === "`") {
			const close = source.indexOf("`", i + 1);
			if (close > i) {
				flush();
				out.push(
					<code key={`c${key++}`} className="bs-markdown__inline-code">
						{source.slice(i + 1, close)}
					</code>,
				);
				i = close + 1;
				continue;
			}
		}

		// Bold: **…**
		if (ch === "*" && source[i + 1] === "*") {
			const close = source.indexOf("**", i + 2);
			if (close > i + 1) {
				flush();
				out.push(
					<strong key={`b${key++}`}>
						{renderInline(source.slice(i + 2, close), onEntityLink, depth + 1)}
					</strong>,
				);
				i = close + 2;
				continue;
			}
		}

		// Italic: *…*
		if (ch === "*") {
			const close = source.indexOf("*", i + 1);
			if (close > i) {
				flush();
				out.push(
					<em key={`i${key++}`}>{renderInline(source.slice(i + 1, close), onEntityLink, depth + 1)}</em>,
				);
				i = close + 1;
				continue;
			}
		}

		// Link: [text](target)
		if (ch === "[") {
			const closeText = source.indexOf("]", i + 1);
			if (closeText > i && source[closeText + 1] === "(") {
				const closeUrl = source.indexOf(")", closeText + 2);
				if (closeUrl > closeText) {
					const text = source.slice(i + 1, closeText);
					const target = source.slice(closeText + 2, closeUrl);
					const link = renderLink(text, target, key, onEntityLink);
					if (link) {
						flush();
						out.push(link);
						key++;
						i = closeUrl + 1;
						continue;
					}
				}
			}
		}

		buffer += ch ?? "";
		i++;
	}
	flush();
	return out;
}

function renderLink(
	text: string,
	target: string,
	key: number,
	onEntityLink?: EntityLinkResolver,
): ReactNode | null {
	if (isSafeLinkUrl(target)) {
		return (
			<a
				key={`l${key}`}
				className="bs-markdown__link"
				href={target}
				target="_blank"
				rel="noreferrer noopener"
			>
				{text}
			</a>
		);
	}
	const handler = onEntityLink?.(target);
	if (handler) {
		return (
			<button key={`l${key}`} type="button" className="bs-markdown__entity-link" onClick={handler}>
				{text}
			</button>
		);
	}
	return null; // unrecognised target → caller falls through to plain text
}
