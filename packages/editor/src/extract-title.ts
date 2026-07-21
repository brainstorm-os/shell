/**
 * extract-title — pure walker that pulls the title text out of a Lexical
 * `SerializedEditorState`. The title lives in the first root child when
 * it's a TitleNode (`type === TITLE_NODE_TYPE`); the function flattens
 * text + inline chip labels in the same shape as `extractPlainText` so the
 * denormalised `properties.title` matches what the user sees.
 *
 * Returns an empty string when the body has no title node yet (legacy
 * documents on first save, or a malformed root). Like `extract-text`, this
 * walker is node-class agnostic — any inline node carrying a string
 * `label` contributes `@<label>` (mirrors the rendered mention chip) — so
 * the shared `@brainstorm-os/editor` helper has no app-local node dependency.
 */

import type { SerializedEditorState } from "lexical";
import { TITLE_NODE_TYPE } from "./nodes/title-node";

export function extractTitle(state: SerializedEditorState | string | null | undefined): string {
	if (!state) return "";
	if (typeof state === "string") return "";
	const root = (state as { root?: { children?: unknown } }).root;
	if (!root || !Array.isArray(root.children)) return "";
	const first = root.children[0];
	if (!first || typeof first !== "object") return "";
	if ((first as { type?: unknown }).type !== TITLE_NODE_TYPE) return "";
	const parts: string[] = [];
	collect(first, parts);
	return parts.join("").replace(/\s+/g, " ").trim();
}

function collect(node: unknown, out: string[]): void {
	if (!node || typeof node !== "object") return;
	const record = node as {
		text?: unknown;
		label?: unknown;
		children?: unknown;
	};
	if (typeof record.text === "string" && record.text) {
		out.push(record.text);
	} else if (typeof record.label === "string" && record.label) {
		out.push(`@${record.label}`);
	}
	if (Array.isArray(record.children)) {
		for (const child of record.children) collect(child, out);
	}
}
