/**
 * Plant an imported markdown body into an entity's universal-body Y.Doc.
 *
 * The Notes / Journal / etc. editors bind to the Y.Doc root via
 * `useYDoc(entityId)` — a markdown string in `properties.body` is only the
 * denormalised search snippet and never reaches the editor. Importers must
 * plant a real Lexical state into the Y.Doc (same contract as Welcome seed /
 * template import) or the editor opens blank.
 *
 * Pipeline: markdown → minimal ImportedBodyState →
 * `plantSerializedStateIntoDoc` → ydoc `applyUpdate`. The converter covers the
 * constructs Anytype / Obsidian / Notion exporters emit (ATX headings, lists,
 * checklists, quotes, fenced code, HRs, paragraphs, basic inline marks). It
 * is deliberately not a full CommonMark parser — fidelity is "readable and
 * editable", not byte-identical to the source.
 */

import {
	BASELINE_NODES,
	SEED_STANDIN_NODES,
	plantSerializedStateIntoDoc,
} from "@brainstorm/editor";
import { Doc, encodeStateAsUpdate } from "yjs";
import { bytesToBase64 } from "../credentials/crypto";
import type { ApplyDocUpdate } from "../welcome/seed-deps";

/** The serialized-state shape `plantSerializedStateIntoDoc` accepts — derived
 * from the editor package so shell-main never needs a direct `lexical` type
 * dependency (lexical is the editor package's own node_modules resolution). */
export type ImportedBodyState = Parameters<typeof plantSerializedStateIntoDoc>[1];

const PLANT_NODES = [...BASELINE_NODES, ...SEED_STANDIN_NODES];

type SerializedNode = {
	type: string;
	version: 1;
	[key: string]: unknown;
};

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

/** Parse a single line of inline markdown into Lexical text/link nodes.
 *  Handles **bold**, *italic*, `code`, [label](url), ![alt](src). Order is
 *  left-to-right, first match wins — good enough for importer bodies. */
function parseInlines(line: string): SerializedNode[] {
	const out: SerializedNode[] = [];
	const re = /(!?\[([^\]]*)\]\(([^)]+)\))|(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`([^`]+)`)/g;
	let last = 0;
	let match: RegExpExecArray | null = re.exec(line);
	while (match) {
		if (match.index > last) out.push(textNode(line.slice(last, match.index)));
		if (match[1] !== undefined) {
			// link or image — images fall back to a labelled link (no remote
			// img in the editor without an asset URL; Obsidian/Anytype rewrites
			// land as brainstorm://asset/… after the media pass).
			const label = match[2] ?? "";
			const url = match[3] ?? "";
			const isImage = match[1].startsWith("!");
			out.push(linkNode(url, [textNode(isImage ? label || url : label || url)]));
		} else if (match[4] !== undefined) {
			out.push(textNode(match[5] ?? "", 1)); // bold
		} else if (match[6] !== undefined) {
			out.push(textNode(match[7] ?? "", 2)); // italic
		} else if (match[8] !== undefined) {
			out.push(textNode(match[9] ?? "", 16)); // code
		}
		last = match.index + match[0].length;
		match = re.exec(line);
	}
	if (last < line.length) out.push(textNode(line.slice(last)));
	if (out.length === 0) out.push(textNode(""));
	return out;
}

function paragraph(children: SerializedNode[]): SerializedNode {
	return {
		type: "paragraph",
		version: 1,
		format: "",
		indent: 0,
		direction: null,
		children,
	};
}

function heading(level: number, children: SerializedNode[]): SerializedNode {
	const tag = level <= 1 ? "h1" : level === 2 ? "h2" : level === 3 ? "h3" : "h4";
	return {
		type: "heading",
		version: 1,
		tag,
		format: "",
		indent: 0,
		direction: null,
		children,
	};
}

function listItem(children: SerializedNode[], checked?: boolean): SerializedNode {
	const item: SerializedNode = {
		type: "listitem",
		version: 1,
		value: 1,
		format: "",
		indent: 0,
		direction: null,
		children: [paragraph(children)],
	};
	if (checked !== undefined) {
		item.checked = checked;
	}
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

function codeBlock(code: string, language: string): SerializedNode {
	return {
		type: "code",
		version: 1,
		language: language || "",
		format: "",
		indent: 0,
		direction: null,
		children: code.length > 0 ? [textNode(code)] : [],
	};
}

function rule(): SerializedNode {
	return { type: "horizontalrule", version: 1 };
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const UL_RE = /^[-*+]\s+(.*)$/;
const OL_RE = /^(\d+)[.)]\s+(.*)$/;
const CHECK_RE = /^[-*+]\s+\[([ xX])\]\s+(.*)$/;
const QUOTE_RE = /^>\s?(.*)$/;
const RULE_RE = /^(?:-{3,}|\*{3,}|_{3,})$/;
const FENCE_RE = /^```/;

/** Convert importer markdown into a Lexical serialized editor state. */
export function markdownToSerializedState(markdown: string): ImportedBodyState {
	const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
	const children: SerializedNode[] = [];
	let i = 0;

	while (i < lines.length) {
		const raw = lines[i] ?? "";
		const t = raw.trim();

		if (t.length === 0) {
			i++;
			continue;
		}

		if (FENCE_RE.test(t)) {
			const language = t.slice(3).trim();
			const body: string[] = [];
			i++;
			while (i < lines.length && !FENCE_RE.test((lines[i] ?? "").trim())) {
				body.push(lines[i] ?? "");
				i++;
			}
			i++; // closing fence
			children.push(codeBlock(body.join("\n"), language));
			continue;
		}

		const h = HEADING_RE.exec(t);
		if (h) {
			children.push(heading(h[1]?.length ?? 1, parseInlines(h[2] ?? "")));
			i++;
			continue;
		}

		if (RULE_RE.test(t)) {
			children.push(rule());
			i++;
			continue;
		}

		const check = CHECK_RE.exec(t);
		if (check) {
			const items: SerializedNode[] = [];
			while (i < lines.length) {
				const m = CHECK_RE.exec((lines[i] ?? "").trim());
				if (!m) break;
				items.push(listItem(parseInlines(m[2] ?? ""), (m[1] ?? " ").toLowerCase() === "x"));
				i++;
			}
			children.push(list("check", items));
			continue;
		}

		const ul = UL_RE.exec(t);
		if (ul) {
			const items: SerializedNode[] = [];
			while (i < lines.length) {
				const m = UL_RE.exec((lines[i] ?? "").trim());
				if (!m || CHECK_RE.test((lines[i] ?? "").trim())) break;
				items.push(listItem(parseInlines(m[1] ?? "")));
				i++;
			}
			children.push(list("bullet", items));
			continue;
		}

		const ol = OL_RE.exec(t);
		if (ol) {
			const items: SerializedNode[] = [];
			while (i < lines.length) {
				const m = OL_RE.exec((lines[i] ?? "").trim());
				if (!m) break;
				items.push(listItem(parseInlines(m[2] ?? "")));
				i++;
			}
			children.push(list("number", items));
			continue;
		}

		const q = QUOTE_RE.exec(t);
		if (q) {
			const quoteLines: string[] = [];
			while (i < lines.length) {
				const m = QUOTE_RE.exec((lines[i] ?? "").trim());
				if (!m) break;
				quoteLines.push(m[1] ?? "");
				i++;
			}
			children.push(quote(parseInlines(quoteLines.join(" "))));
			continue;
		}

		// Paragraph: consume consecutive non-blank, non-block-start lines.
		const paraLines: string[] = [t];
		i++;
		while (i < lines.length) {
			const next = (lines[i] ?? "").trim();
			if (next.length === 0) break;
			if (
				HEADING_RE.test(next) ||
				UL_RE.test(next) ||
				OL_RE.test(next) ||
				CHECK_RE.test(next) ||
				QUOTE_RE.test(next) ||
				RULE_RE.test(next) ||
				FENCE_RE.test(next)
			) {
				break;
			}
			paraLines.push(next);
			i++;
		}
		children.push(paragraph(parseInlines(paraLines.join(" "))));
	}

	if (children.length === 0) {
		children.push(paragraph([textNode("")]));
	}

	return {
		root: {
			type: "root",
			version: 1,
			format: "",
			indent: 0,
			direction: null,
			children,
		},
	} as unknown as ImportedBodyState;
}

/** Plant a Lexical `ImportedBodyState` into `entityId`'s universal-body
 *  Y.Doc (the path Anytype/block-native importers use). */
export async function plantImportSerializedBody(
	entityId: string,
	state: ImportedBodyState,
	applyDocUpdate: ApplyDocUpdate,
): Promise<void> {
	const doc = new Doc();
	try {
		plantSerializedStateIntoDoc(doc, state, {
			nodes: PLANT_NODES,
			namespace: `bs-import-${entityId}`,
		});
		await applyDocUpdate(entityId, bytesToBase64(encodeStateAsUpdate(doc)));
	} finally {
		doc.destroy();
	}
}

/** Plant `markdown` into `entityId`'s universal-body Y.Doc. No-op for empty /
 *  whitespace-only input. Prefer {@link plantImportSerializedBody} when the
 *  importer already has a structured Lexical state (Anytype blocks). */
export async function plantImportMarkdownBody(
	entityId: string,
	markdown: string,
	applyDocUpdate: ApplyDocUpdate,
): Promise<void> {
	const trimmed = markdown.trim();
	if (trimmed.length === 0) return;
	await plantImportSerializedBody(entityId, markdownToSerializedState(trimmed), applyDocUpdate);
}

/** Pull a string body out of a property bag (importers stash markdown under
 *  `body`). Returns null when absent/empty so callers skip the plant. */
export function bodyMarkdownFromProperties(properties: Record<string, unknown>): string | null {
	const raw = properties.body;
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export type { ApplyDocUpdate };
