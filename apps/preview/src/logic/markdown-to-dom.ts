/**
 * Markdown → DOM builder for the Preview app's markdown renderer.
 *
 * The pure parser (`parseMarkdown`, the block model, `isSafeLinkUrl`,
 * `wordCountForMarkdown`) now lives in `@brainstorm/sdk/markdown` — shared with
 * the Agent's React renderer (extracted at copy two). This module keeps only
 * the DOM builder: it constructs DOM nodes one at a time so every user-supplied
 * string becomes a text node, never an HTML fragment (XSS-safe by
 * construction). Re-exports the parser bits so existing importers/tests are
 * unchanged.
 */

import {
	BlockKind,
	type MarkdownBlock,
	isSafeLinkUrl,
	parseMarkdown,
	wordCountForMarkdown,
} from "@brainstorm/sdk/markdown";

export { BlockKind, type MarkdownBlock, isSafeLinkUrl, parseMarkdown, wordCountForMarkdown };

/** Render a parsed block list into a DOM container. Returns the
 *  container so the caller can place it anywhere. `doc` is the
 *  document factory (passed in for testability — JSDOM in tests). */
export function renderBlocksToDom(
	blocks: ReadonlyArray<MarkdownBlock>,
	doc: Document,
): HTMLElement {
	const root = doc.createElement("div");
	root.className = "preview-markdown__doc";
	for (const block of blocks) {
		root.appendChild(renderBlock(block, doc));
	}
	return root;
}

function renderBlock(block: MarkdownBlock, doc: Document): HTMLElement {
	switch (block.kind) {
		case BlockKind.Heading: {
			const el = doc.createElement(`h${block.level}`);
			el.className = "preview-markdown__heading";
			renderInlineInto(block.text, el, doc);
			return el;
		}
		case BlockKind.Paragraph: {
			const el = doc.createElement("p");
			el.className = "preview-markdown__paragraph";
			renderInlineInto(block.text, el, doc);
			return el;
		}
		case BlockKind.CodeFence: {
			const wrap = doc.createElement("pre");
			wrap.className = "preview-markdown__code";
			const code = doc.createElement("code");
			if (block.language) code.setAttribute("data-language", block.language);
			code.textContent = block.code;
			wrap.appendChild(code);
			return wrap;
		}
		case BlockKind.BulletList: {
			const ul = doc.createElement("ul");
			ul.className = "preview-markdown__list";
			for (const item of block.items) {
				const li = doc.createElement("li");
				renderInlineInto(item, li, doc);
				ul.appendChild(li);
			}
			return ul;
		}
		case BlockKind.OrderedList: {
			const ol = doc.createElement("ol");
			ol.className = "preview-markdown__list";
			for (const item of block.items) {
				const li = doc.createElement("li");
				renderInlineInto(item, li, doc);
				ol.appendChild(li);
			}
			return ol;
		}
		case BlockKind.HorizontalRule: {
			return doc.createElement("hr");
		}
	}
}

// Pathological `***...***` nests recurse one level per emphasis pair;
// 32 covers any plausible doc, blocks deeply hostile inputs.
const MAX_INLINE_DEPTH = 32;

/** Render inline marks (code / bold / italic / link) into `parent`.
 *  Walks the string once, greedily matching the next inline marker. */
export function renderInlineInto(
	source: string,
	parent: HTMLElement,
	doc: Document,
	depth = 0,
): void {
	if (depth > MAX_INLINE_DEPTH) {
		parent.appendChild(doc.createTextNode(source));
		return;
	}
	let i = 0;
	let buffer = "";

	function flushText(): void {
		if (buffer.length === 0) return;
		parent.appendChild(doc.createTextNode(buffer));
		buffer = "";
	}

	while (i < source.length) {
		const ch = source[i];

		// Inline code: `…`
		if (ch === "`") {
			const close = source.indexOf("`", i + 1);
			if (close > i) {
				flushText();
				const code = doc.createElement("code");
				code.className = "preview-markdown__inline-code";
				code.textContent = source.slice(i + 1, close);
				parent.appendChild(code);
				i = close + 1;
				continue;
			}
		}

		// Bold: **…**
		if (ch === "*" && source[i + 1] === "*") {
			const close = source.indexOf("**", i + 2);
			if (close > i + 1) {
				flushText();
				const strong = doc.createElement("strong");
				renderInlineInto(source.slice(i + 2, close), strong, doc, depth + 1);
				parent.appendChild(strong);
				i = close + 2;
				continue;
			}
		}

		// Italic: *…* (single-star)
		if (ch === "*") {
			const close = source.indexOf("*", i + 1);
			if (close > i) {
				flushText();
				const em = doc.createElement("em");
				renderInlineInto(source.slice(i + 1, close), em, doc, depth + 1);
				parent.appendChild(em);
				i = close + 1;
				continue;
			}
		}

		// Link: [text](url)
		if (ch === "[") {
			const closeText = source.indexOf("]", i + 1);
			if (closeText > i && source[closeText + 1] === "(") {
				const closeUrl = source.indexOf(")", closeText + 2);
				if (closeUrl > closeText) {
					const text = source.slice(i + 1, closeText);
					const url = source.slice(closeText + 2, closeUrl);
					if (isSafeLinkUrl(url)) {
						flushText();
						const a = doc.createElement("a");
						a.setAttribute("href", url);
						a.setAttribute("rel", "noreferrer noopener");
						a.setAttribute("target", "_blank");
						a.className = "preview-markdown__link";
						a.textContent = text;
						parent.appendChild(a);
						i = closeUrl + 1;
						continue;
					}
				}
			}
		}

		buffer += ch ?? "";
		i++;
	}
	flushText();
}
