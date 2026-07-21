/**
 * migrate-title — one-shot upgrade for legacy stored notes.
 *
 * Pre-title-node notes persisted `{ title: string, body: SerializedEditorState }`
 * with no Title node in the body. This helper rewrites such bodies so
 * the first root child is a TitleNode containing the stored title.
 *
 * Legacy string bodies are passed through unchanged — the editor's
 * `makeInitialState` seeds a TitleNode + paragraph on the string path.
 */

import { type SerializedTitleNode, TITLE_NODE_TYPE } from "@brainstorm-os/editor";
import type { SerializedEditorState, SerializedTextNode } from "lexical";

export function migrateTitleIntoBody(
	body: SerializedEditorState | string,
	storedTitle: string,
): SerializedEditorState | string {
	if (typeof body === "string") return body;
	const root = (body as { root?: { children?: unknown } }).root;
	if (!root || !Array.isArray(root.children)) return body;
	const first = root.children[0];
	if (first && typeof first === "object" && (first as { type?: unknown }).type === TITLE_NODE_TYPE) {
		return body;
	}
	const textNode: SerializedTextNode = {
		type: "text",
		version: 1,
		detail: 0,
		format: 0,
		mode: "normal",
		style: "",
		text: storedTitle,
	};
	const titleNode: SerializedTitleNode = {
		type: TITLE_NODE_TYPE,
		version: 1,
		direction: null,
		format: "",
		indent: 0,
		textFormat: 0,
		textStyle: "",
		children: storedTitle ? [textNode] : [],
	};
	return {
		...body,
		root: {
			...root,
			children: [titleNode, ...(root.children as unknown[])],
		},
	} as SerializedEditorState;
}
