/**
 * extract-text — pure walker that flattens a Lexical
 * `SerializedEditorState` to a single whitespace-collapsed string.
 *
 * Used wherever a UI surface needs to show a body as a one-liner — list
 * row fallbacks when `title` is empty, calendar / week previews, search
 * snippets, mention link previews. Any inline node that carries a string
 * `label` (mention chips, future inline tokens) contributes its label —
 * the visible chip text — so the flattened string matches what a reader
 * sees in the editor. This walker is node-class agnostic on purpose: it
 * is shared by every `@brainstorm-os/editor` consumer and must not depend on
 * an app-local node module.
 */

import type { SerializedEditorState } from "lexical";

export function extractPlainText(state: SerializedEditorState | string | null | undefined): string {
	if (!state) return "";
	if (typeof state === "string") return state.replace(/\s+/g, " ").trim();
	const root = (state as { root?: unknown }).root;
	const parts: string[] = [];
	collect(root, parts);
	return parts.join(" ").replace(/\s+/g, " ").trim();
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
		out.push(record.label);
	}
	if (Array.isArray(record.children)) {
		for (const child of record.children) collect(child, out);
	}
}
