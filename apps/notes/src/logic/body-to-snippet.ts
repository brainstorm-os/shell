/**
 * body-to-snippet — pure helper that pulls a whitespace-collapsed,
 * length-capped plain-text snippet from the universal body Y.XmlText
 * (the `Y.XmlText` named `"root"` per
 *  §Universal rich-text body).
 *
 * Walker — NOT `body.toString()`. The @lexical/yjs binding encodes
 * Lexical's tree as nested `Y.XmlText` blocks (paragraph / heading /
 * list-item) with `Y.Map` text-node markers embedded INSIDE each block's
 * text. `Y.XmlText.toString()` serialises Map embeds via JS coercion
 * (`String(map) === "[object Object]"`), so a snippet built that way
 * carries `[object Object]<text>[object Object]<text>...` markers
 * straight into the entity's denormalised `body` field — Journal /
 * sidebar / cold-cache search then render the corruption back to the
 * user. (Yjs's docs lead you to expect a clean concatenation; reality
 * differs for the Lexical-yjs binding.)
 *
 * Cold-cache note: this helper assumes the doc replica is already
 * resolved (a `<BrainstormEditor>` has been mounted, or the caller
 * holds a `useYDoc(id)` handle). For sidebar rows whose note has never
 * been opened, the snippet path is intentionally NOT walked from the
 * resolver here (refcounting every row across the virtualised list
 * isn't worth the snippet); callers carry a denormalised mirror in
 * `StoredNote.body` written from the autosave commit's
 * SerializedEditorState. See `@brainstorm-os/editor`'s `extractPlainText`
 * for the SerializedEditorState-side walker.
 */

import { DEFAULT_SNIPPET_LENGTH, clipPlainText } from "@brainstorm-os/editor";
import * as Y from "yjs";

export { DEFAULT_SNIPPET_LENGTH } from "@brainstorm-os/editor";

export function bodyToSnippet(body: Y.XmlText, maxChars: number = DEFAULT_SNIPPET_LENGTH): string {
	const parts: string[] = [];
	flattenYText(body, parts);
	return clipPlainText(parts.join(" "), maxChars);
}

/** Recursive Y.XmlText walker. The binding stores Lexical blocks
 *  (paragraph / heading / list-item) as nested `Y.XmlText`s embedded
 *  in the parent XmlText. Text nodes are stored as `Y.Map` markers
 *  followed by direct string inserts in the parent's text stream;
 *  decorator nodes are `Y.XmlElement` embeds. We pick up the string
 *  inserts and recurse into `Y.XmlText` / `Y.XmlElement` embeds; Map
 *  embeds (text-node markers) are skipped — the string content for
 *  that text node is the very next op in the same delta. */
function flattenYText(node: Y.XmlText, out: string[]): void {
	const delta = node.toDelta() as ReadonlyArray<{ insert?: unknown }>;
	for (const op of delta) {
		const insert = op.insert;
		if (typeof insert === "string") {
			out.push(insert);
		} else if (insert instanceof Y.XmlText) {
			flattenYText(insert, out);
		} else if (insert instanceof Y.XmlElement) {
			for (const child of insert.toArray()) {
				if (child instanceof Y.XmlText) flattenYText(child, out);
				else if (child instanceof Y.XmlElement) {
					for (const grand of child.toArray()) {
						if (grand instanceof Y.XmlText) flattenYText(grand, out);
					}
				}
			}
		}
		// Y.Map embeds (Lexical text-node markers) carry no extractable
		// content directly — the actual text is the next string insert
		// in the same delta, which we already pick up above.
	}
}
