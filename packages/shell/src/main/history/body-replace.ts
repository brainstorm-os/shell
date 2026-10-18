/**
 * Whole-body restore (OQ-VH-5) and the read-only body preview — PURE yjs, safe
 * in the ydoc worker bundle.
 *
 * The body is the universal `root` `Y.XmlText` Lexical binds to. A restore is a
 * FORWARD edit: inside one transaction the live root is emptied and refilled
 * with a deep copy of the checkpoint's root, so the change is an ordinary Yjs
 * update that syncs, undoes and merges like any other. Yjs's own `clone()` is
 * not enough here — `YXmlText.clone()` drops the node's attributes (Lexical
 * keeps `__type` & co. there) and re-inserts embedded types that are already
 * integrated, which throws.
 */

import { UNIVERSAL_BODY_FRAGMENT_NAME } from "@brainstorm-os/sdk-types";
import * as Y from "yjs";

type DeltaOp = { insert?: unknown; attributes?: Record<string, unknown> };

function cloneValue(value: unknown): unknown {
	if (value instanceof Y.AbstractType) return cloneType(value);
	if (value === null || typeof value !== "object") return value;
	return structuredClone(value);
}

function cloneAttributes(
	source: Y.XmlText | Y.XmlElement,
	target: Y.XmlText | Y.XmlElement,
): void {
	const attrs = source.getAttributes() as Record<string, unknown>;
	for (const [key, value] of Object.entries(attrs)) {
		(target as Y.XmlElement).setAttribute(key, cloneValue(value) as string);
	}
}

function cloneDelta(delta: readonly DeltaOp[]): DeltaOp[] {
	return delta.map((op) => ({
		...op,
		insert: cloneValue(op.insert),
		...(op.attributes ? { attributes: structuredClone(op.attributes) } : {}),
	}));
}

export function cloneType(type: Y.AbstractType<unknown>): Y.AbstractType<unknown> {
	if (type instanceof Y.XmlText) {
		const out = new Y.XmlText();
		cloneAttributes(type, out);
		out.applyDelta(cloneDelta(type.toDelta() as DeltaOp[]));
		return out;
	}
	if (type instanceof Y.Text) {
		const out = new Y.Text();
		out.applyDelta(cloneDelta(type.toDelta() as DeltaOp[]));
		return out;
	}
	if (type instanceof Y.XmlElement) {
		const out = new Y.XmlElement(type.nodeName);
		cloneAttributes(type, out);
		out.insert(
			0,
			type.toArray().map((child) => cloneType(child as Y.AbstractType<unknown>)) as Y.XmlElement[],
		);
		return out;
	}
	if (type instanceof Y.XmlFragment) {
		const out = new Y.XmlFragment();
		out.insert(
			0,
			type.toArray().map((child) => cloneType(child as Y.AbstractType<unknown>)) as Y.XmlElement[],
		);
		return out;
	}
	if (type instanceof Y.Map) {
		const out = new Y.Map<unknown>();
		type.forEach((value, key) => {
			out.set(key, cloneValue(value));
		});
		return out;
	}
	if (type instanceof Y.Array) {
		const out = new Y.Array<unknown>();
		out.push(type.toArray().map(cloneValue));
		return out;
	}
	throw new Error(`body-replace: cannot clone ${type.constructor.name}`);
}

export function bodyRoot(doc: Y.Doc): Y.XmlText {
	return doc.get(UNIVERSAL_BODY_FRAGMENT_NAME, Y.XmlText) as Y.XmlText;
}

/** Replace `target`'s body with a deep copy of `source`'s, in ONE transaction. */
export function replaceBody(target: Y.Doc, source: Y.Doc): void {
	const from = bodyRoot(source);
	const to = bodyRoot(target);
	const delta = cloneDelta(from.toDelta() as DeltaOp[]);
	const attrs = from.getAttributes() as Record<string, unknown>;
	target.transact(() => {
		if (to.length > 0) to.delete(0, to.length);
		for (const key of Object.keys(to.getAttributes())) to.removeAttribute(key);
		for (const [key, value] of Object.entries(attrs)) {
			to.setAttribute(key, cloneValue(value) as string);
		}
		if (delta.length > 0) to.applyDelta(delta);
	});
}

/** Plain-text cap for the preview — the panel is a glance, not a reader. */
export const BODY_PREVIEW_MAX_CHARS = 20_000;

/** The body flattened to text: block-level `XmlText` embeds become lines;
 *  Lexical's text-node property maps and decorators contribute nothing. */
export function bodyPlainText(doc: Y.Doc, maxChars = BODY_PREVIEW_MAX_CHARS): string {
	const lines: string[] = [];
	let length = 0;
	const walk = (text: Y.XmlText): void => {
		let line = "";
		for (const op of text.toDelta() as DeltaOp[]) {
			if (length + line.length >= maxChars) break;
			if (typeof op.insert === "string") line += op.insert;
			else if (op.insert instanceof Y.XmlText) {
				if (line.trim() !== "") lines.push(line);
				length += line.length;
				line = "";
				walk(op.insert);
			}
		}
		if (line.trim() !== "") {
			lines.push(line);
			length += line.length;
		}
	};
	walk(bodyRoot(doc));
	return lines.join("\n").slice(0, maxChars);
}
