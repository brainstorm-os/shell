/**
 * The standard rich-text node set — `BASELINE_NODES` plus the block nodes
 * the shared `<StandardEditingPlugins>` bundle inserts (callout, toggle,
 * columns, table, horizontal-rule). Any app that mounts the standard
 * editing experience registers this set via
 * `<BrainstormEditor additionalNodes={STANDARD_ADDITIONAL_NODES}>` so the
 * slash menu / block menu commands have a node to create.
 *
 * `FULL_EDITOR_NODES` extends it with the entity-coupled nodes the
 * `<FullEditorPlugins>` typeaheads create (mention / date-mention /
 * transclusion / bookmark / web-embed) so a surface mounting the full
 * editor registers everything those plugins can insert. Apps that want
 * even MORE (Notes' media / property nodes) append their own after these.
 */

import { HorizontalRuleNode } from "@lexical/react/LexicalHorizontalRuleNode";
import { TableCellNode, TableNode, TableRowNode } from "@lexical/table";
import type { Klass, LexicalNode } from "lexical";
import { AudioBlockNode } from "./nodes/audio-block-node";
import { BlockEmbedNode } from "./nodes/block-embed-node";
import { BookmarkNode } from "./nodes/bookmark-node";
import { CalloutNode } from "./nodes/callout-node";
import { ColumnNode, ColumnsNode } from "./nodes/columns-node";
import { DateMentionNode } from "./nodes/date-mention-node";
import { FileBlockNode } from "./nodes/file-block-node";
import { ImageBlockNode } from "./nodes/image-block-node";
import { InlineTransclusionNode } from "./nodes/inline-transclusion-node";
import { MentionNode } from "./nodes/mention-node";
import { ToggleNode } from "./nodes/toggle-node";
import { TransclusionNode } from "./nodes/transclusion-node";
import { VideoBlockNode } from "./nodes/video-block-node";
import { WebEmbedNode } from "./nodes/web-embed-node";

/** Nodes the standard editing bundle needs ON TOP of `BASELINE_NODES`
 *  (which `<BrainstormEditor>` always registers). Pass via `additionalNodes`. */
export const STANDARD_ADDITIONAL_NODES: ReadonlyArray<Klass<LexicalNode>> = [
	CalloutNode,
	ToggleNode,
	ColumnsNode,
	ColumnNode,
	TableNode,
	TableRowNode,
	TableCellNode,
	HorizontalRuleNode,
];

/** The media block nodes the `media` flag on `<FullEditorPlugins>` (and the
 *  Notes editor) inserts: image / video / audio / file. Registered as part of
 *  `FULL_EDITOR_NODES` so any full-editor surface can render media a peer
 *  device authored even when its own `media` flag is off. */
export const MEDIA_NODES: ReadonlyArray<Klass<LexicalNode>> = [
	ImageBlockNode,
	VideoBlockNode,
	AudioBlockNode,
	FileBlockNode,
];

/** The full node set for surfaces mounting `<FullEditorPlugins>` with the
 *  mention / transclusion / embed typeaheads enabled. Superset of
 *  `STANDARD_ADDITIONAL_NODES`. */
export const FULL_EDITOR_NODES: ReadonlyArray<Klass<LexicalNode>> = [
	...STANDARD_ADDITIONAL_NODES,
	MentionNode,
	DateMentionNode,
	TransclusionNode,
	InlineTransclusionNode,
	BookmarkNode,
	WebEmbedNode,
	BlockEmbedNode,
	...MEDIA_NODES,
];
