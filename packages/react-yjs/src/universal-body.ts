/**
 * Helpers for the universal rich-text body root — the `Y.XmlText` named
 * `"root"` in every entity's Y.Doc (per
 *  §Universal rich-text body).
 * This is the well-known root `@lexical/yjs`'s `createBinding` binds to
 * (`doc.get('root', XmlText)`); carrying the universal body via
 * Lexical's own root keeps a single source of truth without forking
 * @lexical/yjs.
 *
 * Centralising the name+helper here means the preload bridge,
 * `<BrainstormEditor>`, Notes / Tasks / Bookmarks per-app workflows,
 * and tests all reach the same root through one call site — a typo or
 * "is it `root` or `Root`" debate is impossible by construction.
 *
 * The root is lazy at the storage layer (Yjs encodes nothing for an
 * untouched root type; `@lexical/yjs`'s bootstrap also writes nothing
 * for an empty document) — calling `getUniversalBody(doc)` materialises
 * the in-memory handle but does not write any encoded state. The
 * `universal-body.test.tsx` lazy-zero-bytes test pins that property.
 */

import { useMemo } from "react";
import * as Y from "yjs";
import { UNIVERSAL_BODY_FRAGMENT_NAME } from "./brainstorm-types";
import { useYXmlText } from "./hooks";
import { b64ToBytes } from "./resolver-accessor";

/**
 * Resolve the universal body `Y.XmlText` on `doc`. Yjs caches the root
 * type by name within the doc — repeated calls return the same
 * instance. The doc-level type guard (`Y.Doc.get(name, Type)` enforces
 * type consistency for a given name) is the protection against
 * collision with a same-named non-XmlText root type.
 */
export function getUniversalBody(doc: Y.Doc): Y.XmlText {
	return doc.get(UNIVERSAL_BODY_FRAGMENT_NAME, Y.XmlText);
}

/**
 * Top-level block count of the universal body. The body is a `Y.XmlText`
 * whose `.length` counts each top-level child element, so for a
 * `@lexical/yjs`-bound doc this is the number of blocks (paragraphs,
 * headings, …). The single source of truth for "how much content is in the
 * body" — `migrate-body`, the empty-doc normaliser, and the blank-render
 * recovery watchdog all measure emptiness through here so they can never
 * disagree (a `.length` vs `.toDelta().length` split was the latent trap).
 */
export function universalBodyBlockCount(doc: Y.Doc): number {
	return getUniversalBody(doc).length;
}

/** True when the universal body has no top-level content — a genuinely empty
 *  doc that bootstrap/normalisation may seed without clobbering real content. */
export function isUniversalBodyEmpty(doc: Y.Doc): boolean {
	return universalBodyBlockCount(doc) === 0;
}

/**
 * React hook companion of `getUniversalBody` — resolves the root
 * (memoised against `doc` identity) and subscribes to its change
 * signal via the cheap `useYXmlText` version store. The Lexical editor
 * binds directly to the same root, so this hook is the change-signal
 * half — it must NOT serialise the body (`text.toString()`) to detect a
 * change: that allocates the whole document on every keystroke for a
 * signal the version counter gives for free. The returned reference is
 * the stable per-doc root so callers can wire `@lexical/yjs` or read its
 * descendants.
 */
export function useUniversalBody(doc: Y.Doc): Y.XmlText {
	const body = useMemo(() => getUniversalBody(doc), [doc]);
	useYXmlText(body);
	return body;
}

/** What a body's first media block is (9.12.31 gallery "first media" cover). */
export enum BodyMediaKind {
	Image = "image",
	Video = "video",
	Embed = "embed",
}

export type BodyMedia = { kind: BodyMediaKind; url: string };

/** Decorator-node `__type`s the gallery treats as media, with the attribute
 *  carrying each one's URL. Mirrors the editor's node type constants
 *  (`image-block`, `video-block`, `web-embed`) — kept here as data so this
 *  package takes no editor dependency. */
const MEDIA_NODES: ReadonlyArray<[string, BodyMediaKind, string]> = [
	["image-block", BodyMediaKind.Image, "__src"],
	["video-block", BodyMediaKind.Video, "__src"],
	["web-embed", BodyMediaKind.Embed, "__embedUrl"],
];

const MAX_MEDIA_WALK = 2000;

/**
 * The first image / video / embed in a doc's universal body, in document
 * order, read straight off the `@lexical/yjs` encoding (decorator nodes are
 * `Y.XmlElement`s whose attributes are the node's `__` fields) — no editor
 * is mounted. Bounded walk so a huge body never stalls a gallery paint.
 */
export function firstBodyMedia(doc: Y.Doc): BodyMedia | null {
	const stack: Y.XmlText[] = [getUniversalBody(doc)];
	let visited = 0;
	while (stack.length > 0 && visited < MAX_MEDIA_WALK) {
		const node = stack.shift() as Y.XmlText;
		const nested: Y.XmlText[] = [];
		for (const op of node.toDelta() as Array<{ insert?: unknown }>) {
			visited += 1;
			const insert = op.insert;
			if (insert instanceof Y.XmlElement) {
				const type = insert.getAttribute("__type");
				const spec = MEDIA_NODES.find(([t]) => t === type);
				const url = spec ? insert.getAttribute(spec[2]) : undefined;
				if (spec && typeof url === "string" && url.length > 0) return { kind: spec[1], url };
			} else if (insert instanceof Y.XmlText) {
				nested.push(insert);
			}
		}
		stack.unshift(...nested);
	}
	return null;
}

/** `firstBodyMedia` over a base64 Y.Doc state update (the `entities.loadDoc`
 *  transport shape) — decodes into a throwaway doc and destroys it. */
export function firstBodyMediaFromUpdate(updateB64: string): BodyMedia | null {
	const doc = new Y.Doc();
	try {
		Y.applyUpdate(doc, b64ToBytes(updateB64));
		return firstBodyMedia(doc);
	} catch {
		return null;
	} finally {
		doc.destroy();
	}
}
