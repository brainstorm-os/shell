/**
 * The baseline node set, defined once so the editor factory, the headless
 * editor (tests + serialization), and any consumer register exactly the
 * same nodes — the set that "round-trips through Yjs cleanly" per
 * .
 *
 * `ParagraphNode` + `TextNode` are Lexical built-ins (always registered)
 * so they are intentionally not listed. Custom app nodes (Notes' Title /
 * Mention / Property blocks) are *not* baseline — they live in their app
 * and, per OQ-12, in a separate registry bridged by `BlockEmbedNode`
 * (Stage 9.4).
 */

import { CodeHighlightNode, CodeNode } from "@lexical/code";
import { AutoLinkNode, LinkNode } from "@lexical/link";
// Side-effect: widen `LinkNode.sanitizeUrl` to the app's `brainstorm://`
// scheme before any editor registers the node set (see link-sanitizer.ts).
import "./link-sanitizer";
import { ListItemNode, ListNode } from "@lexical/list";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import type { Klass, LexicalNode } from "lexical";
import { ImageNode } from "./image-node";

export const BASELINE_NODES: ReadonlyArray<Klass<LexicalNode>> = [
	HeadingNode,
	QuoteNode,
	ListNode,
	ListItemNode,
	LinkNode,
	AutoLinkNode,
	CodeNode,
	CodeHighlightNode,
	ImageNode,
];
