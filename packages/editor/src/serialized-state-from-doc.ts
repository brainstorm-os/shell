/**
 * `serializedStateFromDoc` — read a universal-body Y.Doc back into a
 * serialized-editor-state-shaped tree, WITHOUT a Lexical editor.
 *
 * The inverse of {@link plantSerializedStateIntoDoc} for export paths (the
 * IE-13 whole-vault Markdown export) that run in the shell main process. A
 * headless Lexical editor would need every node class ever written into a body
 * registered, and throws on the first unknown type — so instead this walks the
 * `@lexical/yjs` encoding directly:
 *
 *   - an element node is a `Y.XmlText` whose attributes carry `__type` and its
 *     `__`-prefixed properties, and whose delta interleaves its children;
 *   - a text node is a `Y.Map` (its properties) followed by the string insert
 *     holding its text;
 *   - a line break is a `Y.Map` with `__type: "linebreak"`;
 *   - a decorator node is a `Y.XmlElement` whose attributes are its properties.
 *
 * Unknown types survive as nodes of that type (with their properties), which
 * is exactly what the tolerant `serializedStateToMarkdown` /
 * `serializedStateToHtml` walkers expect. Nested-editor values (`Y.Doc`) and
 * other shared types inside properties are dropped. Returns null for a doc
 * with no body.
 */

import { type Doc, XmlElement, XmlText, Map as YMap } from "yjs";
import type { SerializedEditorStateLike, SerializedNode } from "./preview";

/** The `@lexical/yjs` binding root — `doc.get("root", XmlText)`. */
const ROOT_SHARED_TYPE = "root";

function isPlainValue(value: unknown): boolean {
	if (value === null) return true;
	const kind = typeof value;
	if (kind === "string" || kind === "number" || kind === "boolean") return true;
	if (Array.isArray(value)) return value.every(isPlainValue);
	if (kind === "object") {
		const proto = Object.getPrototypeOf(value);
		return (
			(proto === Object.prototype || proto === null) &&
			Object.values(value as Record<string, unknown>).every(isPlainValue)
		);
	}
	return false;
}

function propsFrom(entries: Iterable<[string, unknown]>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of entries) {
		if (key === "__type" || !isPlainValue(value)) continue;
		out[key.startsWith("__") ? key.slice(2) : key] = value;
	}
	return out;
}

function typeOf(value: unknown, fallback: string): string {
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

function readElement(xml: XmlText, fallbackType: string): SerializedNode {
	const attributes = xml.getAttributes() as Record<string, unknown>;
	const children: SerializedNode[] = [];
	let openText: SerializedNode | null = null;
	for (const op of xml.toDelta() as Array<{ insert?: unknown }>) {
		const insert = op.insert;
		if (typeof insert === "string") {
			if (openText) {
				openText.text = `${String(openText.text ?? "")}${insert}`;
			} else {
				children.push({ type: "text", text: insert, format: 0 });
			}
			continue;
		}
		openText = null;
		if (insert instanceof YMap) {
			const type = typeOf(insert.get("__type"), "text");
			if (type === "linebreak") {
				children.push({ type });
				continue;
			}
			const textNode: SerializedNode = { type, ...propsFrom(insert.entries()), text: "" };
			children.push(textNode);
			openText = textNode;
		} else if (insert instanceof XmlText) {
			children.push(readElement(insert, "paragraph"));
		} else if (insert instanceof XmlElement) {
			const attrs = insert.getAttributes() as Record<string, unknown>;
			children.push({
				type: typeOf(attrs.__type, insert.nodeName || "unknown"),
				...propsFrom(Object.entries(attrs)),
			});
		}
	}
	return {
		type: typeOf(attributes.__type, fallbackType),
		...propsFrom(Object.entries(attributes)),
		children,
	};
}

export function serializedStateFromDoc(doc: Doc): SerializedEditorStateLike | null {
	const root = doc.get(ROOT_SHARED_TYPE, XmlText);
	if (root.length === 0) return null;
	return { root: { ...readElement(root, "root"), type: "root" } };
}
