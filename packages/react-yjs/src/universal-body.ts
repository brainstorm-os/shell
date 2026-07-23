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
